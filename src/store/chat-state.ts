import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import { withBusyRetry } from "./retry.js";

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
}
