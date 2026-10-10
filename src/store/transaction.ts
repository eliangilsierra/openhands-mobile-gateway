import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import { withBusyRetry } from "./retry.js";

/**
 * Runs `fn` inside one `BEGIN IMMEDIATE ... COMMIT` transaction so several repository calls on the
 * same connection (for example `EventCursorRepository.advance` plus `SeenEventRepository.markSeen`)
 * are atomic. Any error rolls back and propagates. Transactions must not be nested; `fn` must be
 * synchronous because `node:sqlite` is.
 */
export function runInTransaction<T>(db: DatabaseSync, logger: Logger, fn: () => T): T {
  withBusyRetry(logger, "transaction.begin", () => {
    db.exec("BEGIN IMMEDIATE");
  });
  let result: T;
  try {
    result = fn();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
  return result;
}
