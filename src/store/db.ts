import { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import { StoreCorruptError } from "./errors.js";
import { runMigrations } from "./schema-migration.js";
import { MIGRATIONS } from "./migrations/index.js";

/**
 * SQLite connection module (architecture §8, ADR-0003).
 *
 * **Choice: `node:sqlite` over `better-sqlite3`.** Both are explicitly allowed by ADR-0003 point
 * 5 and ADR-0002's dependency table. `node:sqlite` is chosen because: (1) it adds **zero**
 * dependencies — ADR-0002 already treats the dependency count itself as the main supply-chain
 * control (T-B4-2), and `node:sqlite`'s `DatabaseSync` is synchronous and API-compatible enough
 * with `better-sqlite3` that this decision is a contained, reversible detail inside this module,
 * exactly as ADR-0003 point 5 anticipates; (2) it needs no native build step in the Docker
 * builder stage, which ADR-0003's "Negative consequences" section calls out as a `better-sqlite3`
 * cost; (3) Node 22.11+ ships it without the `--experimental-sqlite` flag (the project's
 * `engines.node` is `>=22`, and the runtime used in CI/this task is 22.23), with the same
 * pragmas, parameterised statements and transaction semantics this task needs.
 */

export interface OpenStoreOptions {
  readonly databasePath: string;
  readonly logger: Logger;
}

// `node:sqlite`'s `.all()` returns `Record<string, SQLOutputValue>[]`, erasing the actual column
// shape; the cast below is safe because it mirrors the single-column `PRAGMA quick_check` result
// and is exercised by this file's tests.
interface QuickCheckRow {
  readonly quick_check: string;
}

function assertQuickCheckOk(db: DatabaseSync, databasePath: string): void {
  let rows: readonly QuickCheckRow[];
  try {
    rows = db.prepare("PRAGMA quick_check").all() as unknown as readonly QuickCheckRow[];
  } catch (error) {
    throw new StoreCorruptError(`Database at ${databasePath} failed PRAGMA quick_check`, {
      cause: error,
    });
  }

  const isOk = rows.length === 1 && rows[0]?.quick_check === "ok";
  if (!isOk) {
    const detail = rows.map((row) => row.quick_check).join("; ");
    throw new StoreCorruptError(
      `Database at ${databasePath} failed PRAGMA quick_check: ${detail}`,
    );
  }
}

/**
 * Opens the Gateway's single SQLite file, sets the pragmas architecture §8 requires, fails fast
 * if the file is corrupt or unreadable (§10 "SQLite corrupt / volume lost" — this throws
 * {@link StoreCorruptError} instead of starting with a silent empty database), and applies every
 * pending migration inside one transaction (§8 "Migrations").
 */
export function openStore(options: OpenStoreOptions): DatabaseSync {
  const { databasePath, logger } = options;

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath);
  } catch (error) {
    throw new StoreCorruptError(`Failed to open database at ${databasePath}`, { cause: error });
  }

  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA synchronous=NORMAL");
  } catch (error) {
    db.close();
    throw new StoreCorruptError(`Database at ${databasePath} is unreadable or corrupt`, {
      cause: error,
    });
  }

  try {
    assertQuickCheckOk(db, databasePath);
  } catch (error) {
    db.close();
    throw error;
  }

  try {
    runMigrations(db, logger, MIGRATIONS);
  } catch (error) {
    // A migration failure is a developer bug in a migration file, not file corruption; it must
    // not be reported (or handled) as the same condition as §10's "SQLite corrupt" case.
    db.close();
    throw error;
  }

  return db;
}

/** Closes the underlying connection. Safe to call once after `openStore`. */
export function closeStore(db: DatabaseSync): void {
  db.close();
}

export type { Migration } from "./schema-migration.js";
export { StoreCorruptError, StoreError } from "./errors.js";
