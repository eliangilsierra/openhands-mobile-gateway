import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import { withBusyRetry } from "./retry.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** `pending_confirmation` row (architecture §8): one Allow/Deny prompt awaiting an answer. */
export interface PendingConfirmation {
  readonly id: number;
  readonly conversationId: string;
  readonly actionEventId: string;
  readonly channel: string;
  readonly externalChatId: string;
  readonly channelMessageId: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly decision: string | null;
}

export interface CreatePendingConfirmationInput {
  readonly conversationId: string;
  readonly actionEventId: string;
  readonly channel: string;
  readonly externalChatId: string;
  readonly channelMessageId: string;
}

// `node:sqlite`'s `.get()`/`.all()` return `Record<string, SQLOutputValue>`, erasing the actual
// column shape; casts below to this row type are safe because they mirror the exact `SELECT *`
// column list of migration 001 and are exercised by this file's tests.
interface PendingConfirmationRow {
  readonly id: number;
  readonly conversation_id: string;
  readonly action_event_id: string;
  readonly channel: string;
  readonly external_chat_id: string;
  readonly channel_message_id: string;
  readonly created_at: string;
  readonly resolved_at: string | null;
  readonly decision: string | null;
}

function toPendingConfirmation(row: PendingConfirmationRow): PendingConfirmation {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    actionEventId: row.action_event_id,
    channel: row.channel,
    externalChatId: row.external_chat_id,
    channelMessageId: row.channel_message_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    decision: row.decision,
  };
}

export interface PrunePendingConfirmationsOptions {
  /** Clock used to compute the 7-days-after-`resolved_at` cutoff; defaults to `new Date()`. */
  readonly now?: () => Date;
}

/**
 * Intent-level access to `pending_confirmation`: the Allow/Deny prompts behind the confirmation
 * policy (architecture §7.3), plus its prune job.
 */
export class PendingConfirmationRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, logger: Logger, now: () => Date = () => new Date()) {
    this.db = db;
    this.logger = logger;
    this.now = now;
  }

  /** Creates a new, unresolved confirmation prompt. */
  create(input: CreatePendingConfirmationInput): PendingConfirmation {
    const timestamp = this.now().toISOString();
    const result = withBusyRetry(this.logger, "pending_confirmation.create", () =>
      this.db
        .prepare(
          `INSERT INTO pending_confirmation
             (conversation_id, action_event_id, channel, external_chat_id, channel_message_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.conversationId,
          input.actionEventId,
          input.channel,
          input.externalChatId,
          input.channelMessageId,
          timestamp,
        ),
    );

    const row = this.db
      .prepare("SELECT * FROM pending_confirmation WHERE id = ?")
      .get(result.lastInsertRowid) as unknown as PendingConfirmationRow;
    return toPendingConfirmation(row);
  }

  /** The confirmation row for `id`, or `null` if it does not exist. */
  findById(id: number): PendingConfirmation | null {
    const row = withBusyRetry(this.logger, "pending_confirmation.find_by_id", () =>
      this.db.prepare("SELECT * FROM pending_confirmation WHERE id = ?").get(id),
    ) as PendingConfirmationRow | undefined;

    return row ? toPendingConfirmation(row) : null;
  }

  /** The newest confirmation for `(conversationId, actionEventId)`, or `null`. */
  findByAction(conversationId: string, actionEventId: string): PendingConfirmation | null {
    const row = withBusyRetry(this.logger, "pending_confirmation.find_by_action", () =>
      this.db
        .prepare(
          "SELECT * FROM pending_confirmation WHERE conversation_id = ? AND action_event_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(conversationId, actionEventId),
    ) as PendingConfirmationRow | undefined;

    return row ? toPendingConfirmation(row) : null;
  }

  /** Records the id of the prompt message once it was sent. Returns `false` if no row matched. */
  setChannelMessageId(id: number, channelMessageId: string): boolean {
    const result = withBusyRetry(this.logger, "pending_confirmation.set_message_id", () =>
      this.db
        .prepare("UPDATE pending_confirmation SET channel_message_id = ? WHERE id = ?")
        .run(channelMessageId, id),
    );

    return (result.changes as number) > 0;
  }

  /**
   * Re-opens a row that was resolved with exactly `decision` (a claim whose upstream call
   * provably did not happen), so the user can tap again. A no-op otherwise.
   */
  reopen(id: number, decision: string): boolean {
    const result = withBusyRetry(this.logger, "pending_confirmation.reopen", () =>
      this.db
        .prepare(
          "UPDATE pending_confirmation SET resolved_at = NULL, decision = NULL WHERE id = ? AND decision = ?",
        )
        .run(id, decision),
    );

    return (result.changes as number) > 0;
  }

  /**
   * Resolves an unresolved confirmation with `decision` (e.g. `allow`/`deny`). A no-op (returns
   * `false`) when the row is already resolved or does not exist, so the caller's re-check that
   * `resolved_at IS NULL` (threat T-B1-3) cannot be bypassed by answering twice.
   */
  resolve(id: number, decision: string, resolvedAt: string = this.now().toISOString()): boolean {
    const result = withBusyRetry(this.logger, "pending_confirmation.resolve", () =>
      this.db
        .prepare(
          "UPDATE pending_confirmation SET resolved_at = ?, decision = ? WHERE id = ? AND resolved_at IS NULL",
        )
        .run(resolvedAt, decision, id),
    );

    return (result.changes as number) > 0;
  }

  /** Deletes confirmations resolved more than 7 days ago. Returns the number of rows deleted. */
  prune(options: PrunePendingConfirmationsOptions = {}): number {
    const now = options.now ?? (() => new Date());
    const cutoff = new Date(now().getTime() - SEVEN_DAYS_MS).toISOString();

    const result = withBusyRetry(this.logger, "pending_confirmation.prune", () =>
      this.db
        .prepare("DELETE FROM pending_confirmation WHERE resolved_at IS NOT NULL AND resolved_at < ?")
        .run(cutoff),
    );

    return result.changes as number;
  }
}
