import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import { StoreError } from "./errors.js";

/**
 * One forward-only, additive schema change (architecture §8, ADR-0003 point 6). `sql` is a
 * static string written by a developer, never built from runtime input, so it is exempt from
 * the "parameterised statements only" rule (T-B3-1) that applies to every repository method.
 */
export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

function isNoSuchTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

/** The highest version recorded in `schema_migration`, or 0 before that table exists. */
function getAppliedVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migration").get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  } catch (error) {
    if (isNoSuchTableError(error)) {
      return 0;
    }
    throw error;
  }
}

function assertMigrationsOrdered(migrations: readonly Migration[]): void {
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new StoreError(
        `Migrations must be numbered 1..N with no gaps or reordering; expected version ` +
          `${expectedVersion} at position ${index}, found ${migration.version}`,
      );
    }
  }
}

/**
 * Applies every migration whose version is greater than the currently applied one, inside a
 * single transaction, and records each applied version in `schema_migration`. A no-op when the
 * database is already fully migrated (idempotent). On any failure the transaction is rolled
 * back, so the database is left exactly as it was before this call.
 */
export function runMigrations(
  db: DatabaseSync,
  logger: Logger,
  migrations: readonly Migration[],
): void {
  assertMigrationsOrdered(migrations);

  const appliedVersion = getAppliedVersion(db);
  const pending = migrations.filter((migration) => migration.version > appliedVersion);

  if (pending.length === 0) {
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  logger.info(`Store schema migrated to version ${pending[pending.length - 1]?.version}`, {
    event: "store.migrated",
  });
}

/** One row of `schema_migration`: the version applied and when. */
export interface AppliedMigration {
  readonly version: number;
  readonly appliedAt: string;
}

// `node:sqlite`'s `.get()`/`.all()` return `Record<string, SQLOutputValue>`, erasing the actual
// column shape; the cast below to this row type is safe because it mirrors the exact `SELECT`
// column list and is exercised by this file's tests.
interface SchemaMigrationRow {
  readonly version: number;
  readonly applied_at: string;
}

/**
 * Read-only, intent-level access to `schema_migration`, for callers that only need to inspect
 * the applied schema version (e.g. `/health?verbose=1`) without running the migration runner.
 */
export class SchemaMigrationRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** The highest applied migration version, or `0` if none has been applied yet. */
  getCurrentVersion(): number {
    return getAppliedVersion(this.db);
  }

  /** Every applied migration, in ascending version order. */
  listApplied(): readonly AppliedMigration[] {
    const rows = this.db
      .prepare("SELECT version, applied_at FROM schema_migration ORDER BY version ASC")
      .all() as unknown as readonly SchemaMigrationRow[];

    return rows.map((row) => ({ version: row.version, appliedAt: row.applied_at }));
  }
}
