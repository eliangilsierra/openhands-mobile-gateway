import type { LogLevel } from "./config.js";

/**
 * Single-line JSON logger to stdout (architecture §11).
 *
 * Two independent controls keep secrets out of the logs (NFR-5, AC-16):
 * 1. An **allowlist** of loggable fields — any field not in the allowlist is dropped, so a
 *    future `log.info(obj)` cannot leak a new field by accident.
 * 2. A **redaction hook** that replaces every occurrence of a known secret value in the
 *    serialised line with `***`, so even an allowed field (e.g. `err_msg`) cannot leak a
 *    secret that ends up inside its text. Adding a new secret is a one-line addition to the
 *    `secrets` array passed to {@link createLogger}.
 */

export type LoggableFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, fields?: LoggableFields): void;
  info(msg: string, fields?: LoggableFields): void;
  warn(msg: string, fields?: LoggableFields): void;
  error(msg: string, fields?: LoggableFields): void;
}

export interface LoggerOptions {
  /** Minimum level that is actually written. */
  readonly level: LogLevel;
  /** Known secret values; every occurrence is replaced with `***` before the line is written. */
  readonly secrets: readonly string[];
  readonly now?: () => Date;
  readonly write?: (line: string) => void;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Fields allowed at every level (architecture §11's field set, minus `ts`/`level`/`msg`). */
const CORE_FIELDS: ReadonlySet<string> = new Set([
  "event",
  "request_id",
  "channel",
  "chat_ref",
  "project_key",
  "conversation_id",
  "event_id",
  "kind",
  "duration_ms",
  "status",
  "err_type",
  "err_msg",
]);

/** Allowed only when the call itself is at `debug` level (architecture §11: "paths only at DEBUG"). */
const DEBUG_ONLY_FIELDS: ReadonlySet<string> = new Set(["working_dir"]);

/** Never emitted, at any level (architecture §11: "Never ... at INFO", and never a secret carrier). */
const DENIED_FIELDS: ReadonlySet<string> = new Set([
  "text",
  "content",
  "token",
  "api_key",
  "authorization",
]);

function filterFields(
  fields: LoggableFields | undefined,
  callLevel: LogLevel,
): Record<string, unknown> {
  const allowed: Record<string, unknown> = {};
  if (!fields) {
    return allowed;
  }

  for (const [key, value] of Object.entries(fields)) {
    if (DENIED_FIELDS.has(key)) {
      continue;
    }
    if (DEBUG_ONLY_FIELDS.has(key)) {
      if (callLevel === "debug") {
        allowed[key] = value;
      }
      continue;
    }
    if (CORE_FIELDS.has(key)) {
      allowed[key] = value;
    }
    // Any other field is outside the allowlist and is dropped, not just redacted.
  }

  return allowed;
}

function redact(line: string, secrets: readonly string[]): string {
  let redacted = line;
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
}

export function createLogger(options: LoggerOptions): Logger {
  const { level, secrets } = options;
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });

  function log(callLevel: LogLevel, msg: string, fields?: LoggableFields): void {
    if (LEVEL_ORDER[callLevel] < LEVEL_ORDER[level]) {
      return;
    }

    const record = {
      ts: now().toISOString(),
      level: callLevel,
      msg,
      ...filterFields(fields, callLevel),
    };

    write(redact(JSON.stringify(record), secrets));
  }

  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}
