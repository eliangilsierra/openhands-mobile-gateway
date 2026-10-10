import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
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
 * cost; (3) Node ships it without the `--experimental-sqlite` flag since 22.13.0 (the project's
 * `engines.node` is `>=22.13`; it still prints an ExperimentalWarning), with the same
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

// Error messages carry neither the absolute path nor the raw quick_check output; the detail goes
// to the structured log only.
function assertQuickCheckOk(db: DatabaseSync, logger: Logger): void {
  let rows: readonly QuickCheckRow[];
  try {
    rows = db.prepare("PRAGMA quick_check").all() as unknown as readonly QuickCheckRow[];
  } catch (error) {
    logger.error("SQLite quick_check could not run", {
      event: "store.quick_check_failed",
      err_msg: error instanceof Error ? error.message : "unknown",
    });
    throw new StoreCorruptError("Database failed PRAGMA quick_check", { cause: error });
  }

  const isOk = rows.length === 1 && rows[0]?.quick_check === "ok";
  if (!isOk) {
    logger.error("SQLite quick_check reported corruption", {
      event: "store.quick_check_failed",
      err_msg: rows.map((row) => row.quick_check).join("; "),
    });
    throw new StoreCorruptError("Database failed PRAGMA quick_check");
  }
}

/**
 * The store holds conversation bindings and pending confirmations, so only the owner may read it:
 * the parent directory is created `0700` and the database file `0600` before SQLite opens it, so
 * SQLite's `-wal`/`-shm` side files inherit the mode. Existing side files are tightened too. An
 * already existing parent directory is left as the operator configured it.
 */
function prepareDatabaseFile(databasePath: string): void {
  // In-memory (":memory:"), empty (temporary) and URI ("file:...") targets are not plain files.
  if (databasePath === "" || databasePath === ":memory:" || databasePath.startsWith("file:")) {
    return;
  }
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  closeSync(openSync(databasePath, "a", 0o600));
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${databasePath}${suffix}`;
    if (existsSync(file)) {
      chmodSync(file, 0o600);
    }
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
    prepareDatabaseFile(databasePath);
    db = new DatabaseSync(databasePath);
  } catch (error) {
    throw new StoreCorruptError("Failed to open database", { cause: error });
  }

  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA synchronous=NORMAL");
  } catch (error) {
    db.close();
    throw new StoreCorruptError("Database is unreadable or corrupt", { cause: error });
  }

  try {
    assertQuickCheckOk(db, logger);
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
