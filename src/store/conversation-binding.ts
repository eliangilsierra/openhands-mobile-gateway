import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import { withBusyRetry } from "./retry.js";

export type ConversationBindingState = "active" | "stale" | "closed";

/** `conversation_binding` row (architecture §8): one chat↔project↔conversation mapping. */
export interface ConversationBinding {
  readonly id: number;
  readonly channel: string;
  readonly externalChatId: string;
  readonly projectKey: string;
  readonly workingDir: string;
  readonly conversationId: string;
  readonly state: ConversationBindingState;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export interface CreateConversationBindingInput {
  readonly channel: string;
  readonly externalChatId: string;
  readonly projectKey: string;
  readonly workingDir: string;
  readonly conversationId: string;
}

// `node:sqlite`'s `.get()`/`.all()` return `Record<string, SQLOutputValue>`, erasing the actual
// column shape; casts below to this row type are safe because they mirror the exact `SELECT *`
// column list of migration 001 and are exercised by this file's tests.
interface ConversationBindingRow {
  readonly id: number;
  readonly channel: string;
  readonly external_chat_id: string;
  readonly project_key: string;
  readonly working_dir: string;
  readonly conversation_id: string;
  readonly state: ConversationBindingState;
  readonly created_at: string;
  readonly last_used_at: string;
}

function toConversationBinding(row: ConversationBindingRow): ConversationBinding {
  return {
    id: row.id,
    channel: row.channel,
    externalChatId: row.external_chat_id,
    projectKey: row.project_key,
    workingDir: row.working_dir,
    conversationId: row.conversation_id,
    state: row.state,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Intent-level access to `conversation_binding`. The database — not application code — is the
 * source of truth for "only one active binding per (channel, externalChatId, projectKey)"
 * (T-AC-1): `create` relies on the partial unique index from migration 001 and lets the
 * resulting `SQLITE_CONSTRAINT` error propagate to the caller rather than pre-checking it, which
 * would be a race between two Gateway writers if that ever happened.
 */
export class ConversationBindingRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, logger: Logger, now: () => Date = () => new Date()) {
    this.db = db;
    this.logger = logger;
    this.now = now;
  }

  /**
   * Creates a new binding in state `active`. Throws the underlying `node:sqlite` error (code
   * `ERR_SQLITE_ERROR`, `errcode` 2067/19) when a second active binding for the same
   * `(channel, externalChatId, projectKey)` already exists, or when `conversationId` is reused.
   */
  create(input: CreateConversationBindingInput): ConversationBinding {
    const timestamp = this.now().toISOString();
    const result = withBusyRetry(this.logger, "conversation_binding.create", () =>
      this.db
        .prepare(
          `INSERT INTO conversation_binding
             (channel, external_chat_id, project_key, working_dir, conversation_id, state, created_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          input.channel,
          input.externalChatId,
          input.projectKey,
          input.workingDir,
          input.conversationId,
          timestamp,
          timestamp,
        ),
    );

    const row = this.db
      .prepare("SELECT * FROM conversation_binding WHERE id = ?")
      .get(result.lastInsertRowid) as unknown as ConversationBindingRow;
    return toConversationBinding(row);
  }

  /** The active binding for `(channel, externalChatId, projectKey)`, or `null` if none exists. */
  findActive(channel: string, externalChatId: string, projectKey: string): ConversationBinding | null {
    const row = withBusyRetry(this.logger, "conversation_binding.find_active", () =>
      this.db
        .prepare(
          `SELECT * FROM conversation_binding
           WHERE channel = ? AND external_chat_id = ? AND project_key = ? AND state = 'active'`,
        )
        .get(channel, externalChatId, projectKey),
    ) as ConversationBindingRow | undefined;

    return row ? toConversationBinding(row) : null;
  }

  /** The binding for a given OpenHands `conversationId`, regardless of state, or `null`. */
  findByConversationId(conversationId: string): ConversationBinding | null {
    const row = withBusyRetry(this.logger, "conversation_binding.find_by_conversation_id", () =>
      this.db.prepare("SELECT * FROM conversation_binding WHERE conversation_id = ?").get(conversationId),
    ) as ConversationBindingRow | undefined;

    return row ? toConversationBinding(row) : null;
  }

  /** Marks the binding `stale` (architecture §10: "Conversation 404 upstream"). */
  markStale(conversationId: string): void {
    withBusyRetry(this.logger, "conversation_binding.mark_stale", () =>
      this.db
        .prepare("UPDATE conversation_binding SET state = 'stale' WHERE conversation_id = ?")
        .run(conversationId),
    );
  }

  /** Updates `last_used_at` to now, e.g. after a task or event is handled for this conversation. */
  touchLastUsed(conversationId: string): void {
    const timestamp = this.now().toISOString();
    withBusyRetry(this.logger, "conversation_binding.touch_last_used", () =>
      this.db
        .prepare("UPDATE conversation_binding SET last_used_at = ? WHERE conversation_id = ?")
        .run(timestamp, conversationId),
    );
  }
}
