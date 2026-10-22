# `src/store/`

The Gateway's persistence layer: one SQLite file (`DATABASE_PATH`, see `src/config.ts`),
a forward-only migration runner, and one repository per entity from architecture §8 "Data".
ADR-0003 (Accepted) is the governing decision; read it before changing anything here.

## Connection (`db.ts`)

`openStore({ databasePath, logger })` opens the database with `node:sqlite`'s `DatabaseSync`,
sets `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`, runs
`PRAGMA quick_check`, and applies every pending migration — all before returning the connection.
If the file cannot be opened or fails `quick_check`, it throws `StoreCorruptError` instead of
starting with a silently empty database (architecture §10). The caller (`src/main.ts`) must treat
that as fatal: log it and exit non-zero.

**Why `node:sqlite` and not `better-sqlite3`:** both are allowed by ADR-0003 point 5. `node:sqlite`
was chosen because it adds no new dependency (ADR-0002 treats the dependency count itself as the
main supply-chain control) and needs no native build step in the Docker builder stage. It is a
contained, reversible choice inside this module only.

## Migrations (`migrations/`, `schema-migration.ts`)

- **Numbered, forward-only, additive.** Each file is `NNN_description.ts`, exporting a
  `Migration` (`{ version, description, sql }`), and is listed in `migrations/index.ts` in
  ascending order with no gaps.
- **Never edit a migration that has shipped.** A schema change — a new table, a new nullable
  column, a new index — is always a **new** numbered file. Dropping a column, renaming one, or
  changing a `NOT NULL`/`CHECK` constraint on an existing table is a destructive migration and is
  forbidden by convention (architecture §8, ADR-0003 point 6); it needs a new ADR first.
- `runMigrations` applies every migration above the currently recorded version inside a single
  transaction and records each version in `schema_migration`. Re-running it against an
  already-migrated database is a no-op (idempotent), which is what `openStore` relies on at every
  boot.

## Repositories

One file per entity, each exposing **intent-level methods only** (`findActive`, `markStale`,
`advance`, `hasSeen`, `prune`, …) — never a generic query builder. Every statement is
parameterised; no repository method ever concatenates untrusted input into SQL (T-B3-1). Callers
outside `src/store/` must never write SQL themselves.

| File | Entity | Notes |
| --- | --- | --- |
| `chat-state.ts` | `chat_state` | active project per chat |
| `conversation-binding.ts` | `conversation_binding` | the partial unique index (migration 001) enforces one active binding per `(channel, externalChatId, projectKey)`; repositories do not pre-check it, they let the constraint error propagate |
| `event-cursor.ts` | `event_cursor` | resume point for WS reconnect/replay |
| `seen-event.ts` | `seen_event` | dedupe set; `prune()` keeps the most recent `SEEN_EVENT_KEEP` rows (default 2000) or 7 days, whichever is larger |
| `pending-confirmation.ts` | `pending_confirmation` | Allow/Deny prompts; `expireUnresolved()` expires unanswered ones, `prune()` deletes rows resolved more than 7 days ago |
| `retention.ts` | (all) | the scheduled retention pass described below |
| `schema-migration.ts` | `schema_migration` | the migration runner plus read-only access to the applied version |

### Retention of personal identifiers

`chat_state` and `conversation_binding` hold chat and conversation IDs, so they are not kept
forever. `src/store/retention.ts` runs one pass at startup and then hourly (`main.ts` schedules it
and stops the timer on shutdown); `RETENTION_DAYS` (default 30) is the age. Each pass, in order:

1. `PendingConfirmationRepository.expireUnresolved(maxAgeMs)`: a prompt nobody answered within the
   age is resolved with decision `expired`, so it cannot pin its binding forever. A late tap finds
   it resolved and does nothing.
2. `ConversationBindingRepository.pruneInactive(maxAgeMs)`: deletes `closed` and `stale` bindings
   whose `last_used_at` is strictly older than `maxAgeMs`, and in the same transaction the
   `event_cursor` and `seen_event` rows of those conversations. `active` bindings and bindings with
   an unresolved confirmation are never deleted (nor their replay rows). An oversized or invalid
   `maxAgeMs` throws `RangeError`.
3. `PendingConfirmationRepository.prune()`: deletes confirmations resolved more than 7 days ago.
4. `SeenEventRepository.pruneAll()`: the per-conversation `seen_event` prune for every conversation.

Erasure on request: `ChatStateRepository.delete(channel, externalChatId)` removes **only** the
`chat_state` row; it is not a full erasure. `ChatStateRepository.eraseChat(channel, externalChatId)`
removes, in one transaction, the chat's `chat_state`, all its bindings (any state, including
`active`) with their `event_cursor` and `seen_event` rows, and its `pending_confirmation` rows. No
command calls it yet (`/forget` is out of V1 scope).

## Supported database targets

Only plain filesystem paths and `:memory:` (or the empty path, a private temporary database) are
supported. `file:` URIs are rejected with a `StoreError` because they would bypass the 0700/0600
file hardening.

## Retry policy (`retry.ts`)

`withBusyRetry(logger, kind, fn)` wraps every repository statement. On `SQLITE_BUSY` it retries
up to 3 times with 50/100/200 ms backoff (architecture §10), logging each retry; any other error,
or a `SQLITE_BUSY` on the last retry, propagates so the single operation fails while the process
keeps running. Busy detection masks the result code with `0xff`, so extended codes (261, 517)
retry too. The backoff uses `Atomics.wait`, which blocks the event loop for up to 350 ms per
failed operation; this is acceptable for a single-process gateway with a 5 s `busy_timeout`.

## Transactions and file modes

`runInTransaction(db, logger, fn)` (`transaction.ts`) runs several repository calls atomically,
for example `EventCursorRepository.advance` plus `SeenEventRepository.markSeen`. The database
directory is created `0700` and the database, `-wal` and `-shm` files are `0600`.
