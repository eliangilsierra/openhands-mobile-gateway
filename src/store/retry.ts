import type { Logger } from "../logger.js";

/**
 * `SQLITE_BUSY` retry/backoff policy (architecture §10: "Retry 3× with 50/100/200 ms backoff,
 * then fail the single operation and log; process keeps running"). One entry per retry, so the
 * total attempts made by {@link withBusyRetry} is `1 + SQLITE_BUSY_RETRY_DELAYS_MS.length`.
 */
export const SQLITE_BUSY_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200];

/**
 * The primary result code for `SQLITE_BUSY` (https://www.sqlite.org/rescode.html#busy). Extended
 * codes (for example `SQLITE_BUSY_RECOVERY` 261, `SQLITE_BUSY_SNAPSHOT` 517) keep it in the low
 * byte, so detection masks with `0xff`.
 */
const SQLITE_BUSY_ERRCODE = 5;

interface NodeSqliteError extends Error {
  readonly code?: string;
  readonly errcode?: number;
}

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const sqliteError = error as NodeSqliteError;
  return (
    sqliteError.code === "ERR_SQLITE_ERROR" &&
    typeof sqliteError.errcode === "number" &&
    (sqliteError.errcode & 0xff) === SQLITE_BUSY_ERRCODE
  );
}

/**
 * Blocks the current thread for `ms` milliseconds. `node:sqlite`'s `DatabaseSync` is a
 * synchronous API, so the backoff between retries must also be synchronous; `Atomics.wait` on a
 * throwaway buffer is the standard way to do that in Node without a native dependency. It blocks
 * the event loop for the whole delay (at most 350 ms per failed operation).
 */
function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Runs `operation`, retrying it on `SQLITE_BUSY` per the backoff policy above, and logging each
 * retry (never silently). Any other error, or a `SQLITE_BUSY` on the last retry, propagates to
 * the caller so that single operation fails while the process keeps running.
 */
export function withBusyRetry<T>(logger: Logger, kind: string, operation: () => T): T {
  let attempt = 0;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= SQLITE_BUSY_RETRY_DELAYS_MS.length) {
        throw error;
      }
      const delayMs = SQLITE_BUSY_RETRY_DELAYS_MS[attempt] ?? 0;
      logger.warn("SQLite busy; retrying operation", {
        event: "store.sqlite_busy_retry",
        kind,
        duration_ms: delayMs,
      });
      sleepSync(delayMs);
      attempt += 1;
    }
  }
}
