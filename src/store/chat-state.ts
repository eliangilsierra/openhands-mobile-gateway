import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import { withBusyRetry } from "./retry.js";
import { runInTransaction } from "./transaction.js";

/** `chat_state` row (architecture §8): the active project remembered for one Telegram chat. */
export interface ChatState {
  readonly channel: string;
  readonly externalChatId: string;
  readonly activeProject: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// `node:sqlite`'s `.get()`/`.all()` return `Record<string, SQLOutputValue>`, erasing the actual
// column shape; the cast below to this file's row type is safe because it mirrors the exact
// `SELECT` column list of migration 001 and is exercised by this file's tests.
interface ChatStateRow {
  readonly channel: string;
  readonly external_chat_id: string;
  readonly active_project: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function toChatState(row: ChatStateRow): ChatState {
  return {
    channel: row.channel,
    externalChatId: row.external_chat_id,
    activeProject: row.active_project,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Intent-level access to `chat_state`: get or set the active project remembered for one chat.
 * Every statement is parameterised (T-B3-1); no caller ever builds SQL from `channel`,
 * `externalChatId` or `project`.
 */
export class ChatStateRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, logger: Logger, now: () => Date = () => new Date()) {
    this.db = db;
    this.logger = logger;
    this.now = now;
  }

  /** The active project for `(channel, externalChatId)`, or `null` when none is set. */
  getActiveProject(channel: string, externalChatId: string): string | null {
    const row = withBusyRetry(this.logger, "chat_state.get", () =>
      this.db
        .prepare("SELECT active_project FROM chat_state WHERE channel = ? AND external_chat_id = ?")
        .get(channel, externalChatId),
    ) as { active_project: string | null } | undefined;

    return row?.active_project ?? null;
  }

  /** The full row for `(channel, externalChatId)`, or `null` when the chat has no state yet. */
  find(channel: string, externalChatId: string): ChatState | null {
    const row = withBusyRetry(this.logger, "chat_state.find", () =>
      this.db
        .prepare("SELECT * FROM chat_state WHERE channel = ? AND external_chat_id = ?")
        .get(channel, externalChatId),
    ) as ChatStateRow | undefined;

    return row ? toChatState(row) : null;
  }

  /** Creates the row if it does not exist, otherwise updates `active_project` and `updated_at`. */
  setActiveProject(channel: string, externalChatId: string, project: string | null): void {
    const timestamp = this.now().toISOString();
    withBusyRetry(this.logger, "chat_state.set", () =>
      this.db
        .prepare(
          `INSERT INTO chat_state (channel, external_chat_id, active_project, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (channel, external_chat_id)
           DO UPDATE SET active_project = excluded.active_project, updated_at = excluded.updated_at`,
        )
        .run(channel, externalChatId, project, timestamp, timestamp),
    );
  }

  /**
   * Deletes the state of one chat on request (retention policy, see `src/store/README.md`).
   * Returns `true` when a row existed. Bindings, confirmations and dedupe rows are left untouched:
   * this is NOT a full erasure, use {@link eraseChat} for that.
   */
  delete(channel: string, externalChatId: string): boolean {
    const result = withBusyRetry(this.logger, "chat_state.delete", () =>
      this.db
        .prepare("DELETE FROM chat_state WHERE channel = ? AND external_chat_id = ?")
        .run(channel, externalChatId),
    );
    return Number(result.changes) > 0;
  }

  /**
   * Full erasure of one chat in a single transaction: its `chat_state` row, every binding of the
   * chat (any state, including `active`) with the `event_cursor` and `seen_event` rows of those
   * conversations, and the chat's `pending_confirmation` rows. Other chats are untouched. Nothing
   * calls it yet (`/forget` is out of V1 scope); it exists so erasure on request is possible.
   * Must not run inside another transaction.
   */
  eraseChat(channel: string, externalChatId: string): EraseChatResult {
    return runInTransaction(this.db, this.logger, () => {
      const conversations = `SELECT conversation_id FROM conversation_binding
        WHERE channel = ? AND external_chat_id = ?`;
      this.db
        .prepare(`DELETE FROM event_cursor WHERE conversation_id IN (${conversations})`)
        .run(channel, externalChatId);
      this.db
        .prepare(`DELETE FROM seen_event WHERE conversation_id IN (${conversations})`)
        .run(channel, externalChatId);
      const confirmations = this.db
        .prepare("DELETE FROM pending_confirmation WHERE channel = ? AND external_chat_id = ?")
        .run(channel, externalChatId);
      const bindings = this.db
        .prepare("DELETE FROM conversation_binding WHERE channel = ? AND external_chat_id = ?")
        .run(channel, externalChatId);
      const state = this.db
        .prepare("DELETE FROM chat_state WHERE channel = ? AND external_chat_id = ?")
        .run(channel, externalChatId);
      return {
        chatState: Number(state.changes) > 0,
        bindings: Number(bindings.changes),
        confirmations: Number(confirmations.changes),
      };
    });
  }
}

/** What {@link ChatStateRepository.eraseChat} removed. */
export interface EraseChatResult {
  readonly chatState: boolean;
  readonly bindings: number;
  readonly confirmations: number;
}
