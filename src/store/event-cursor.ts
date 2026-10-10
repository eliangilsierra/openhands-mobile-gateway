import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import { withBusyRetry } from "./retry.js";

/** `event_cursor` row (architecture §8): the last event seen for one conversation's subscription. */
export interface EventCursor {
  readonly conversationId: string;
  readonly lastEventId: string | null;
  readonly lastEventTimestamp: string | null;
  readonly updatedAt: string;
}

// `node:sqlite`'s `.get()` returns `Record<string, SQLOutputValue>`, erasing the actual column
// shape; the cast below is safe because it mirrors the exact `SELECT *` column list of
// migration 001 and is exercised by this file's tests.
interface EventCursorRow {
  readonly conversation_id: string;
  readonly last_event_id: string | null;
  readonly last_event_timestamp: string | null;
  readonly updated_at: string;
}

function toEventCursor(row: EventCursorRow): EventCursor {
  return {
    conversationId: row.conversation_id,
    lastEventId: row.last_event_id,
    lastEventTimestamp: row.last_event_timestamp,
    updatedAt: row.updated_at,
  };
}

/**
 * Intent-level access to `event_cursor`: read or advance the resume point used for WebSocket
 * reconnect (`resend_mode=since&after_timestamp=<cursor>`, architecture §10).
 */
export class EventCursorRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, logger: Logger, now: () => Date = () => new Date()) {
    this.db = db;
    this.logger = logger;
    this.now = now;
  }

  /** The cursor for `conversationId`, or `null` when no event has been recorded yet. */
  read(conversationId: string): EventCursor | null {
    const row = withBusyRetry(this.logger, "event_cursor.read", () =>
      this.db.prepare("SELECT * FROM event_cursor WHERE conversation_id = ?").get(conversationId),
    ) as EventCursorRow | undefined;

    return row ? toEventCursor(row) : null;
  }

  /**
   * Creates or overwrites the cursor for `conversationId`. ADR-0003 point 4 requires that this
   * runs in the **same transaction** as the matching `seen_event` insert; callers that need that
   * atomicity must open their own transaction around both calls, since each repository method
   * here is a single statement by design.
   */
  advance(conversationId: string, lastEventId: string, lastEventTimestamp: string): void {
    const timestamp = this.now().toISOString();
    withBusyRetry(this.logger, "event_cursor.advance", () =>
      this.db
        .prepare(
          `INSERT INTO event_cursor (conversation_id, last_event_id, last_event_timestamp, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (conversation_id)
           DO UPDATE SET
             last_event_id = excluded.last_event_id,
             last_event_timestamp = excluded.last_event_timestamp,
             updated_at = excluded.updated_at`,
        )
        .run(conversationId, lastEventId, lastEventTimestamp, timestamp),
    );
  }
}
