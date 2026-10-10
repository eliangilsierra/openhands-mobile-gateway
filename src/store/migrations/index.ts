import migration001Init from "./001_init.js";
import type { Migration } from "../schema-migration.js";

/**
 * Every migration, in ascending version order. `runMigrations` (schema-migration.ts) asserts
 * this list is numbered 1..N without gaps, so a missing or misordered entry here fails loudly
 * at boot rather than silently skipping a migration.
 */
export const MIGRATIONS: readonly Migration[] = [migration001Init];
