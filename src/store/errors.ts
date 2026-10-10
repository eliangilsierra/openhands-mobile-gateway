/** Base error for every failure raised by `src/store/`. Always carries a `cause` when one exists. */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
  }
}

/**
 * Raised when the database file cannot be opened or fails `PRAGMA quick_check` at boot
 * (architecture §10 "SQLite corrupt / volume lost"). The caller (`src/main.ts`) must treat this
 * as fatal: log it and exit non-zero, never start with a silently empty database.
 */
export class StoreCorruptError extends StoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreCorruptError";
  }
}
