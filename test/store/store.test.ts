import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatStateRepository } from "../../src/store/chat-state.js";
import { ConversationBindingRepository } from "../../src/store/conversation-binding.js";
import { closeStore, openStore, StoreCorruptError } from "../../src/store/db.js";
import { EventCursorRepository } from "../../src/store/event-cursor.js";
import { MIGRATIONS } from "../../src/store/migrations/index.js";
import { PendingConfirmationRepository } from "../../src/store/pending-confirmation.js";
import {
  runMigrations,
  SchemaMigrationRepository,
  type Migration,
} from "../../src/store/schema-migration.js";
import { SeenEventRepository } from "../../src/store/seen-event.js";
import { runInTransaction } from "../../src/store/transaction.js";
import { SQLITE_BUSY_RETRY_DELAYS_MS, withBusyRetry } from "../../src/store/retry.js";
import { createRecordingLogger, createTempDbPath } from "./helpers.js";

const NASTY = "x'; DROP TABLE chat_state; --";

let temp: ReturnType<typeof createTempDbPath>;
let db: DatabaseSync;
const logger = createRecordingLogger();

beforeEach(() => {
  temp = createTempDbPath();
  db = openStore({ databasePath: temp.path, logger });
});

afterEach(() => {
  try {
    closeStore(db);
  } catch {
    // already closed by the test
  }
  temp.cleanup();
});

function tableNames(conn: DatabaseSync): string[] {
  const rows = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  return rows.map((r) => String(r["name"]));
}

describe("openStore / migrations", () => {
  it("creates all six tables from architecture section 8 and sets pragmas", () => {
    expect(tableNames(db)).toEqual([
      "chat_state",
      "conversation_binding",
      "event_cursor",
      "pending_confirmation",
      "schema_migration",
      "seen_event",
    ]);
    expect(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("wal");
    expect(db.prepare("PRAGMA busy_timeout").get()?.["timeout"]).toBe(5000);
    expect(db.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"]).toBe(1);
    expect(new SchemaMigrationRepository(db).getCurrentVersion()).toBe(1);
  });

  it("is a no-op when run again on an already-migrated database", () => {
    const before = new SchemaMigrationRepository(db).listApplied();
    runMigrations(db, logger, MIGRATIONS);
    expect(new SchemaMigrationRepository(db).listApplied()).toEqual(before);
  });

  it("applies migrations in order and rolls back everything on failure", () => {
    const empty = new DatabaseSync(":memory:");
    const good: Migration = { version: 1, description: "a", sql: "CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE a (id INTEGER);" };
    const second: Migration = { version: 2, description: "b", sql: "CREATE TABLE b (id INTEGER);" };
    const bad: Migration = { version: 3, description: "bad", sql: "CREATE TABLE c (id INTEGER); THIS IS NOT SQL;" };

    runMigrations(empty, logger, [good, second]);
    expect(new SchemaMigrationRepository(empty).listApplied().map((m) => m.version)).toEqual([1, 2]);

    expect(() => runMigrations(empty, logger, [good, second, bad])).toThrow();
    expect(tableNames(empty)).not.toContain("c");
    expect(new SchemaMigrationRepository(empty).getCurrentVersion()).toBe(2);
    empty.close();
  });

  it("rejects a migration list with gaps or reordering", () => {
    const conn = new DatabaseSync(":memory:");
    expect(() =>
      runMigrations(conn, logger, [{ version: 2, description: "x", sql: "SELECT 1;" }]),
    ).toThrow(/numbered 1\.\.N/);
    conn.close();
  });

  it("T-AC-3: fails fast with StoreCorruptError on a corrupt file", () => {
    closeStore(db);
    writeFileSync(temp.path, "this is definitely not a sqlite database file");
    expect(() => openStore({ databasePath: temp.path, logger })).toThrow(StoreCorruptError);
  });
});

describe("ChatStateRepository", () => {
  it("returns null, then stores and updates the active project", () => {
    const repo = new ChatStateRepository(db, logger);
    expect(repo.getActiveProject("telegram", "1")).toBeNull();
    repo.setActiveProject("telegram", "1", "alpha");
    repo.setActiveProject("telegram", "1", "beta");
    expect(repo.getActiveProject("telegram", "1")).toBe("beta");
    expect(repo.find("telegram", "1")?.activeProject).toBe("beta");
    expect(repo.getActiveProject("telegram", "2")).toBeNull();
  });

  it("T-AC-5: treats SQL metacharacters as data", () => {
    const repo = new ChatStateRepository(db, logger);
    repo.setActiveProject("telegram", NASTY, NASTY);
    expect(repo.getActiveProject("telegram", NASTY)).toBe(NASTY);
    expect(tableNames(db)).toContain("chat_state");
  });
});

describe("ConversationBindingRepository", () => {
  const input = {
    channel: "telegram",
    externalChatId: "1",
    projectKey: "alpha",
    workingDir: "/projects/alpha",
    conversationId: "conv-1",
  };

  it("creates, finds, touches and marks stale", () => {
    const repo = new ConversationBindingRepository(db, logger);
    const created = repo.create(input);
    expect(created.state).toBe("active");
    expect(repo.findActive("telegram", "1", "alpha")?.conversationId).toBe("conv-1");
    expect(repo.findByConversationId("conv-1")?.id).toBe(created.id);

    repo.touchLastUsed("conv-1");
    repo.markStale("conv-1");
    expect(repo.findActive("telegram", "1", "alpha")).toBeNull();
    expect(repo.findByConversationId("conv-1")?.state).toBe("stale");
  });

  it("T-AC-1: the partial unique index rejects a second active binding for the same key", () => {
    const repo = new ConversationBindingRepository(db, logger);
    repo.create(input);
    expect(() => repo.create({ ...input, conversationId: "conv-2" })).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO conversation_binding (channel, external_chat_id, project_key, working_dir, conversation_id, state, created_at, last_used_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run("telegram", "1", "alpha", "/p", "conv-3", "active", "t", "t"),
    ).toThrow(/UNIQUE/);
  });

  it("allows a new active binding once the previous one is stale, and other projects", () => {
    const repo = new ConversationBindingRepository(db, logger);
    repo.create(input);
    repo.markStale("conv-1");
    expect(repo.create({ ...input, conversationId: "conv-2" }).state).toBe("active");
    expect(repo.create({ ...input, projectKey: "beta", conversationId: "conv-3" }).state).toBe("active");
  });

  it("T-AC-2: a binding is readable unchanged after reopening the same file", () => {
    const created = new ConversationBindingRepository(db, logger).create(input);
    closeStore(db);
    db = openStore({ databasePath: temp.path, logger });
    expect(new ConversationBindingRepository(db, logger).findActive("telegram", "1", "alpha")).toEqual(created);
  });

  it("T-AC-5: treats SQL metacharacters as data", () => {
    const repo = new ConversationBindingRepository(db, logger);
    repo.create({ ...input, projectKey: NASTY, workingDir: NASTY, conversationId: NASTY });
    expect(repo.findActive("telegram", "1", NASTY)?.workingDir).toBe(NASTY);
    expect(tableNames(db)).toContain("conversation_binding");
  });
});

describe("EventCursorRepository", () => {
  it("reads null, then advances and overwrites", () => {
    const repo = new EventCursorRepository(db, logger);
    expect(repo.read("c1")).toBeNull();
    repo.advance("c1", "e1", "2026-01-01T00:00:00Z");
    repo.advance("c1", "e2", "2026-01-02T00:00:00Z");
    expect(repo.read("c1")).toMatchObject({ lastEventId: "e2", lastEventTimestamp: "2026-01-02T00:00:00Z" });
  });
});

describe("SeenEventRepository", () => {
  it("records idempotently and reports seen", () => {
    const repo = new SeenEventRepository(db, logger);
    expect(repo.hasSeen("c1", "e1")).toBe(false);
    repo.markSeen("c1", "e1");
    repo.markSeen("c1", "e1");
    expect(repo.hasSeen("c1", "e1")).toBe(true);
    expect(repo.hasSeen("c2", "e1")).toBe(false);
  });

  it("T-AC-4: prune keeps the most recent N rows older than 7 days, and all rows younger than 7 days", () => {
    const repo = new SeenEventRepository(db, logger);
    const now = new Date("2026-10-10T00:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    // 10 old rows (10 days old, ascending), 3 recent rows (1 day old).
    for (let i = 0; i < 10; i += 1) {
      repo.markSeen("c1", `old${i}`, new Date(now.getTime() - 10 * day + i * 1000).toISOString());
    }
    for (let i = 0; i < 3; i += 1) {
      repo.markSeen("c1", `new${i}`, new Date(now.getTime() - day + i * 1000).toISOString());
    }
    repo.markSeen("c2", "other", new Date(now.getTime() - 30 * day).toISOString());

    const deleted = repo.prune("c1", { keep: 5, now: () => now });

    // Top 5 by recency = new0..new2 + old8, old9; the remaining 8 old rows go.
    expect(deleted).toBe(8);
    expect(repo.hasSeen("c1", "old9")).toBe(true);
    expect(repo.hasSeen("c1", "old8")).toBe(true);
    expect(repo.hasSeen("c1", "old7")).toBe(false);
    expect(repo.hasSeen("c1", "new0")).toBe(true);
    expect(repo.hasSeen("c2", "other")).toBe(true);
  });

  it("prune never deletes rows younger than 7 days even beyond keep", () => {
    const repo = new SeenEventRepository(db, logger);
    const now = new Date("2026-10-10T00:00:00.000Z");
    for (let i = 0; i < 6; i += 1) {
      repo.markSeen("c1", `e${i}`, new Date(now.getTime() - 1000 * (i + 1)).toISOString());
    }
    expect(repo.prune("c1", { keep: 2, now: () => now })).toBe(0);
  });
});

describe("PendingConfirmationRepository", () => {
  const input = {
    conversationId: "c1",
    actionEventId: "a1",
    channel: "telegram",
    externalChatId: "1",
    channelMessageId: "m1",
  };

  it("creates, resolves once, and rejects a second resolution", () => {
    const repo = new PendingConfirmationRepository(db, logger);
    const created = repo.create(input);
    expect(created.resolvedAt).toBeNull();
    expect(repo.resolve(created.id, "allow")).toBe(true);
    expect(repo.resolve(created.id, "deny")).toBe(false);
    expect(repo.findById(created.id)).toMatchObject({ decision: "allow" });
    expect(repo.findById(9999)).toBeNull();
  });

  it("prunes only rows resolved more than 7 days ago", () => {
    const repo = new PendingConfirmationRepository(db, logger);
    const now = new Date("2026-10-10T00:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const oldRow = repo.create(input);
    const recent = repo.create(input);
    const unresolved = repo.create(input);
    repo.resolve(oldRow.id, "allow", new Date(now.getTime() - 8 * day).toISOString());
    repo.resolve(recent.id, "deny", new Date(now.getTime() - 1 * day).toISOString());

    expect(repo.prune({ now: () => now })).toBe(1);
    expect(repo.findById(oldRow.id)).toBeNull();
    expect(repo.findById(recent.id)).not.toBeNull();
    expect(repo.findById(unresolved.id)).not.toBeNull();
  });

  it("T-AC-5: treats SQL metacharacters as data", () => {
    const repo = new PendingConfirmationRepository(db, logger);
    const created = repo.create({ ...input, conversationId: NASTY, actionEventId: NASTY });
    expect(repo.findById(created.id)?.conversationId).toBe(NASTY);
    expect(repo.resolve(created.id, NASTY)).toBe(true);
    expect(repo.findById(created.id)?.decision).toBe(NASTY);
  });
});

describe("SQLITE_BUSY retry", () => {
  it("retries a held lock with backoff, logs, and then fails the single operation", () => {
    const busyLogger = createRecordingLogger();
    const other = new DatabaseSync(temp.path);
    other.exec("PRAGMA busy_timeout=1");
    db.exec("PRAGMA busy_timeout=1");
    db.exec("BEGIN IMMEDIATE");

    const repo = new ChatStateRepository(other, busyLogger);
    const started = Date.now();
    expect(() => repo.setActiveProject("telegram", "1", "alpha")).toThrow(/locked/);
    const elapsed = Date.now() - started;

    const retries = busyLogger.records.filter((r) => r.fields?.["event"] === "store.sqlite_busy_retry");
    expect(retries).toHaveLength(SQLITE_BUSY_RETRY_DELAYS_MS.length);
    expect(elapsed).toBeGreaterThanOrEqual(340);

    db.exec("ROLLBACK");
    other.close();
  });

  it("succeeds when the lock is released between attempts", () => {
    const l = createRecordingLogger();
    let calls = 0;
    const result = withBusyRetry(l, "test", () => {
      calls += 1;
      if (calls < 3) {
        throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry non-busy errors", () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(createRecordingLogger(), "test", () => {
        calls += 1;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(calls).toBe(1);
  });
});

describe("busy detection with extended result codes", () => {
  it.each([5, 261, 517])("retries when errcode is %i", (errcode) => {
    let calls = 0;
    const result = withBusyRetry(createRecordingLogger(), "test", () => {
      calls += 1;
      if (calls < 2) {
        throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode });
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry a non-busy extended code such as SQLITE_CONSTRAINT_UNIQUE (2067)", () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(createRecordingLogger(), "test", () => {
        calls += 1;
        throw Object.assign(new Error("unique"), { code: "ERR_SQLITE_ERROR", errcode: 2067 });
      }),
    ).toThrow("unique");
    expect(calls).toBe(1);
  });
});

describe("in-memory database", () => {
  it("opens :memory: without creating a file in the working directory", () => {
    const mem = openStore({ databasePath: ":memory:", logger });
    try {
      expect(existsSync(":memory:")).toBe(false);
      expect(existsSync(join(process.cwd(), ":memory:"))).toBe(false);
      const repo = new ChatStateRepository(mem, logger);
      repo.setActiveProject("telegram", "1", "alpha");
      expect(repo.getActiveProject("telegram", "1")).toBe("alpha");
    } finally {
      closeStore(mem);
    }
  });
});

describe("file permissions", () => {
  it("creates the directory 0700 and the db, -wal and -shm files 0600", () => {
    const fresh = createTempDbPath();
    try {
      const nested = join(dirname(fresh.path), "data", "store");
      const dbPath = join(nested, "gateway.db");
      const conn = openStore({ databasePath: dbPath, logger });
      new ChatStateRepository(conn, logger).setActiveProject("telegram", "1", "alpha");
      expect(statSync(nested).mode & 0o777).toBe(0o700);
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(statSync(`${dbPath}${suffix}`).mode & 0o777).toBe(0o600);
      }
      closeStore(conn);
    } finally {
      fresh.cleanup();
    }
  });
});

describe("StoreCorruptError messages", () => {
  it("contains neither the absolute path nor raw quick_check output; the log carries the detail", () => {
    closeStore(db);
    writeFileSync(temp.path, "this is definitely not a sqlite database file");
    const l = createRecordingLogger();
    let caught: unknown;
    try {
      openStore({ databasePath: temp.path, logger: l });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreCorruptError);
    const message = (caught as Error).message;
    expect(message).not.toContain(temp.path);
    expect(message).not.toContain(dirname(temp.path));
    expect(message).not.toMatch(/malformed|not a database|corrupt:/i);
  });
});

describe("runInTransaction", () => {
  it("commits the cursor advance and the seen_event insert together", () => {
    const cursor = new EventCursorRepository(db, logger);
    const seen = new SeenEventRepository(db, logger);
    runInTransaction(db, logger, () => {
      cursor.advance("c1", "e1", "2026-10-10T00:00:00.000Z");
      seen.markSeen("c1", "e1");
    });
    expect(cursor.read("c1")?.lastEventId).toBe("e1");
    expect(seen.hasSeen("c1", "e1")).toBe(true);
  });

  it("rolls both back when the callback throws", () => {
    const cursor = new EventCursorRepository(db, logger);
    const seen = new SeenEventRepository(db, logger);
    expect(() =>
      runInTransaction(db, logger, () => {
        cursor.advance("c1", "e1", "2026-10-10T00:00:00.000Z");
        seen.markSeen("c1", "e1");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(cursor.read("c1")).toBeNull();
    expect(seen.hasSeen("c1", "e1")).toBe(false);
    expect(db.isTransaction).toBe(false);
  });

  it("returns the callback result", () => {
    expect(runInTransaction(db, logger, () => 42)).toBe(42);
  });
});
