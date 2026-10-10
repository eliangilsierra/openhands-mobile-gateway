import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, LoggableFields } from "../../src/logger.js";

/** A `Logger` that records every call instead of writing to stdout, for assertions in tests. */
export interface RecordingLogger extends Logger {
  readonly records: ReadonlyArray<{ level: string; msg: string; fields?: LoggableFields }>;
}

export function createRecordingLogger(): RecordingLogger {
  const records: Array<{ level: string; msg: string; fields?: LoggableFields }> = [];
  const record = (level: string) => (msg: string, fields?: LoggableFields) => {
    records.push(fields === undefined ? { level, msg } : { level, msg, fields });
  };

  return {
    records,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

/** Creates a fresh temp directory and returns a `gateway.db` path inside it, plus a cleanup fn. */
export function createTempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gateway-store-test-"));
  return {
    path: join(dir, "gateway.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
