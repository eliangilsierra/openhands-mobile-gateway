import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import { withBusyRetry } from "./retry.js";

/** Default retention for `seen_event` (ADR-0003 point 7, architecture §8). */
export const SEEN_EVENT_KEEP = 2000;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface PruneSeenEventsOptions {
  /** Rows per conversation to keep regardless of age. Defaults to {@link SEEN_EVENT_KEEP}. */
  readonly keep?: number;
  /** Clock used to compute the 7-day cutoff; defaults to `new Date()`. */
  readonly now?: () => Date;
}

/**
 * Intent-level access to `seen_event`: the dedupe set that makes event re-delivery after a crash
 * or reconnect idempotent (architecture §8, ADR-0003 point 4), plus its prune job.
 */
export class SeenEventRepository {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  constructor(db: DatabaseSync, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  /** Whether `eventId` has already been recorded for `conversationId`. */
  hasSeen(conversationId: string, eventId: string): boolean {
    const row = withBusyRetry(this.logger, "seen_event.has_seen", () =>
      this.db
        .prepare("SELECT 1 AS found FROM seen_event WHERE conversation_id = ? AND event_id = ?")
        .get(conversationId, eventId),
    );

    return row !== undefined;
  }

  /**
   * Records `eventId` as seen for `conversationId`. Idempotent: recording the same pair twice is
   * a silent no-op rather than a constraint error, since at-least-once delivery means this is the
   * expected, non-exceptional case.
   */
  markSeen(conversationId: string, eventId: string, seenAt: string = new Date().toISOString()): void {
    withBusyRetry(this.logger, "seen_event.mark_seen", () =>
      this.db
        .prepare(
          "INSERT INTO seen_event (conversation_id, event_id, seen_at) VALUES (?, ?, ?) ON CONFLICT (conversation_id, event_id) DO NOTHING",
        )
        .run(conversationId, eventId, seenAt),
    );
  }

  /**
   * Deletes `seen_event` rows for `conversationId` older than 7 days, except the most recent
   * `keep` rows (default {@link SEEN_EVENT_KEEP}), which are always kept regardless of age
   * (architecture §8's retention: "most recent `SEEN_EVENT_KEEP` rows, or 7 days, whichever is
   * larger"). Returns the number of rows deleted.
   */
  prune(conversationId: string, options: PruneSeenEventsOptions = {}): number {
    const keep = options.keep ?? SEEN_EVENT_KEEP;
    const now = options.now ?? (() => new Date());
    const cutoff = new Date(now().getTime() - SEVEN_DAYS_MS).toISOString();

    const result = withBusyRetry(this.logger, "seen_event.prune", () =>
      this.db
        .prepare(
          `DELETE FROM seen_event
           WHERE conversation_id = ?
             AND seen_at < ?
             AND event_id NOT IN (
               SELECT event_id FROM seen_event
               WHERE conversation_id = ?
               ORDER BY seen_at DESC, event_id DESC
               LIMIT ?
             )`,
        )
        .run(conversationId, cutoff, conversationId, keep),
    );

    return result.changes as number;
  }
}
