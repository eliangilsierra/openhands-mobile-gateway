# ADR-0003: Persist all Gateway state in a single SQLite file on a Docker volume

## Status

Proposed

| Field | Value |
| --- | --- |
| Date proposed | 2026-10-08 |
| Date decided | — |
| Decided by | — |
| Related Issue | [#1](https://github.com/eliangilsierra/openhands-mobile-gateway/issues/1) |
| Supersedes | None |
| Related ADRs | ADR-0001 (topology), ADR-0002 (runtime), ADR-0005 (what is stored), ADR-0006 (event cursor) |

## Context

FR-8 and AC-9/AC-10 require that the mapping between a Telegram chat and its OpenHands
`conversation_id` survives Gateway restarts and remains valid across days, so that "continúa con lo
que encontraste ayer" reaches yesterday's conversation. NFR-6 extends this to one mapping per
project per chat. OpenHands cannot help: `StartConversationRequest` carries only
`workspace.working_dir`, there is no uniqueness constraint tying a directory to a conversation, and
the server does not track "the active conversation for a project" (R3-F1, R3-F3, R3-I1). The
bookkeeping is unavoidably the Gateway's.

ADR-0006 adds a second durable need: an **event cursor** (last seen event id and timestamp) and a
**seen-event set**, because recovery after a WebSocket disconnect is timestamp-based and can
re-deliver events (R2-F22, R2-I5). Section 7.3 of the architecture document adds a third: a
**pending-confirmation** row, because Telegram's `callback_data` is limited to 64 bytes (R3-E2) and
cannot carry a conversation UUID plus an event UUID.

Constraints and context:

- **NFR-2** is explicit: *"prefers SQLite over Redis/Postgres if sufficient; no Kubernetes, no extra
  reverse proxy, no message broker/queue/worker/scheduler unless proven necessary"*, and no new
  ongoing cost.
- **NFR-10** states SQLite as a soft, overridable preference.
- Load is tiny and single-writer: one owner, a handful of projects, a few dozen writes per active
  task (cursor advances), well under one write per second sustained. There is no multi-tenancy, no
  reporting, no analytics and no cross-instance coordination requirement.
- Issue risk R-3 flags SQLite contention if Coolify ever ran multiple Gateway replicas.
- Total persisted volume over a year is on the order of a few megabytes (identifiers and timestamps
  only — no message content, see below).

The decision is hard to reverse because it fixes the data access layer, the migration mechanism, the
backup story and — critically — the "exactly one process" operational constraint.

## Decision

We will **confirm the stated preference**: all Gateway state lives in **one SQLite database file at
`/data/gateway.db`**, on a named Docker volume `gateway-state` mounted only by the `mobile-gateway`
service. There is **no other datastore** — no Redis, no Postgres, no broker, no external cache, no
second file format.

Specifics that make this decidable:

1. **Schema** (architecture §8): `chat_state`, `conversation_binding`, `event_cursor`, `seen_event`,
   `pending_confirmation`, `schema_migration`. Six small tables.
2. **Pragmas:** `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`.
3. **Exactly one writer, exactly one process.** Running two Gateway instances is **unsupported** and
   is documented as such in the README. This is not a limitation we are accepting reluctantly: a
   second instance would also break Telegram long polling with a 409 (ADR-0004), so the single-instance
   constraint exists independently of the store.
4. **No secret and no message content is ever stored.** `TELEGRAM_BOT_TOKEN` and
   `OPENHANDS_API_KEY` stay in process memory only. Conversation history belongs to OpenHands
   (G-2); the Gateway keeps identifiers, cursors and timestamps. This also settles open question
   **Q-8** with the conservative default: **Telegram message history is not persisted.** Changing
   that is a new requirement with its own privacy decision, not a silent default.
5. **Access:** `better-sqlite3` (synchronous, fast, battle-tested) or Node 22's built-in
   `node:sqlite` — the choice between the two is a contained implementation detail inside
   `src/store/` and does not need an ADR. **Parameterised statements only**; no string-built SQL
   anywhere.
6. **Migrations:** numbered, forward-only, **additive** SQL files applied at boot inside a
   transaction, with the applied version recorded in `schema_migration`. Rollback is "redeploy the
   previous image", which is safe precisely because migrations only add tables or nullable/defaulted
   columns that older code ignores. **Destructive migrations are forbidden by convention**; if one is
   ever genuinely needed it requires a new ADR.
7. **Retention:** `seen_event` is pruned to the most recent 2000 rows per conversation (or 7 days,
   whichever is larger); `pending_confirmation` rows are deleted 7 days after `resolved_at`;
   `conversation_binding` and `chat_state` are kept indefinitely because FR-8/AC-10 depend on them.
8. **Corruption handling:** at boot, open the database and run `PRAGMA quick_check`. On failure,
   **fail fast and exit non-zero** with a clear log line. A silently recreated empty database would
   be worse than a crash: it would orphan every conversation and create duplicates on the next
   message.
9. **Backup:** the supported procedure is `sqlite3 /data/gateway.db ".backup /data/backup.db"`
   (documented in the README). Losing the file costs only the mapping — the conversations themselves
   live in `canvas-state` and can be re-bound with `/use`.

## Alternatives

| Alternative | Summary | Why not chosen |
| --- | --- | --- |
| **No persistence — keep the mapping in memory** | Simplest possible option; the map is rebuilt by asking the user to `/use` after every restart. | The genuinely simplest alternative, so it deserves the explicit answer: it **fails FR-8, AC-9 and AC-10**, which are stated requirements, not conveniences. A restart (or a Coolify redeploy) would silently start a new conversation and lose the agent's context. Rejected because a requirement forbids it. |
| **A JSON file written on change** | No dependency at all; trivially inspectable. | Attractive for six tiny tables, and nearly viable. Rejected for three reasons: no atomic read-modify-write without hand-rolling a temp-file-and-rename dance (a crash mid-write loses the whole mapping, not one row); the `seen_event` dedupe lookup and pruning want an index, which means re-implementing one; and migrations become bespoke code. SQLite gives transactions, indexes and a migration idiom for one dependency. |
| **Redis** | Fast key/value store with TTLs, which `seen_event` and `pending_confirmation` would use naturally. | **Explicitly excluded by NFR-2** unless proven necessary, and nothing here proves it: there is no multi-process coordination, no pub/sub need, and no latency requirement a local file cannot meet. It would add a container to operate, secure, back up and patch, and would make the state non-durable by default. Rejected. |
| **PostgreSQL** | Real concurrency, real migrations, a path to multiple instances. | **Explicitly excluded by NFR-2.** Its advantages (concurrent writers, network access, roles) address problems this system does not have at one user. It would add a service, a password, a backup regime and a non-trivial amount of operational surface for six tables of identifiers. Rejected — and recorded as the documented migration target if §13's third escalation step is ever reached. |
| **Reuse the `agentcanvas` state (`canvas-state` volume) or an OpenHands API field** | Store the mapping where OpenHands already keeps data — e.g. in conversation metadata via `PATCH /api/conversations/{id}`. | Mounting `canvas-state` into the Gateway violates the spirit of FR-10 and would let a Gateway bug corrupt the canvas's own state. Encoding the mapping in conversation titles/metadata is hacky, unindexed, requires a full `conversations/search` scan to answer "which conversation belongs to this chat and project", and would make the Gateway's correctness depend on a field OpenHands is free to overwrite. Rejected. |
| **Persist in Telegram itself** (e.g. a pinned message holding the mapping) | Zero infrastructure. | Novel but fragile: rate-limited, user-visible, editable by the owner, and it would make Telegram a hard dependency for the OpenHands layer, breaking NFR-8. Rejected. |

## Consequences

**Positive**

- Satisfies FR-8/AC-9/AC-10/NFR-6 with **zero new infrastructure and zero cost**, exactly as NFR-2
  demands.
- Transactions give a correctness property the design actually relies on: the event cursor advance
  and the `seen_event` insert happen in the **same** transaction, so a crash re-delivers an event
  (at-least-once, deduped on restart) rather than losing it.
- Operationally trivial: one file to back up, one file to copy off the VPS, one file to delete to
  reset the Gateway.
- Fully inspectable with `sqlite3` on the VPS when debugging a mapping problem.
- No network, no credentials, no second process in the trust model.

**Negative**

- **Hard single-instance constraint.** The Gateway cannot be horizontally scaled or run
  blue/green. Accepted: one owner, and ADR-0004 imposes the same constraint anyway. Documented in the
  README so a future operator does not discover it through data corruption.
- A corrupt or lost volume loses every chat↔conversation binding. Mitigated by fail-fast detection, a
  documented backup command, and the fact that recovery is a `/use` away.
- `better-sqlite3` is a native module, so the image build needs build tooling in the builder stage
  (avoided entirely if `node:sqlite` is used — one reason that option is open).
- Migrations being additive-only is a real constraint on future schema work; renaming a column means
  adding a new one and leaving the old.

**Follow-up actions**

- Work package 2 implements the schema, the migration runner and the prune jobs.
- Work package 14 documents the backup command and the single-instance rule in the README.

## Security considerations

- **Classification:** `chat_state.external_chat_id` and `conversation_binding` rows are pseudonymous
  **personal data** (a Telegram chat ID identifies the owner). Everything else is internal
  identifiers. **No secrets and no message content are stored**, which is the single most important
  property of this decision: a leaked `gateway.db` exposes "this chat worked on these projects",
  not credentials and not task content.
- **Encryption at rest: none, deliberately.** The file holds no secret, the volume is mounted only
  by this service, and the VPS has no disk-encryption requirement in any NFR. Adding encryption would
  require a key to manage and protect nothing of value.
- **Injection:** parameterised statements only (project names and free text are the untrusted inputs
  and both reach the store as bound parameters). This is a lint- and review-enforced rule;
  architecture threat T-B3-1.
- **Access control:** container filesystem only, non-root UID, named volume mounted by exactly one
  service (threat T-B3-2). No network listener; SQLite is a library, not a server, so this ADR adds
  **no** new trust boundary and no new authentication decision.
- **Auditability:** `pending_confirmation.decision` provides a durable record of which Allow/Deny the
  owner actually gave, supporting the repudiation threat T-B1-5.
- **Logging:** the store must never log row contents at `INFO`; `working_dir` is a `DEBUG`-only field
  (NFR-5).

## Operational considerations

- **Volume:** `gateway-state:/data`, created by Compose on first `up`. Nothing else mounts it.
- **Backup/restore:** `docker exec mobile-gateway sqlite3 /data/gateway.db ".backup /data/backup.db"`
  then copy the file out; restore by stopping the service, replacing the file, starting it. No
  coordination with `agentcanvas` is needed.
- **RPO/RTO:** no NFR specifies them. Stated target: RPO = time since the last manual backup; RTO =
  container restart time (seconds). The state of record (conversations and their history) lives in
  `canvas-state` and is unaffected by Gateway data loss.
- **Monitoring:** `/health` reports `sqlite: up|down` from a `SELECT 1` on the open connection
  (NFR-4, AC-15). `SQLITE_BUSY` after the 5 s `busy_timeout` is retried 3× (50/100/200 ms) and then
  fails the single operation while the process keeps running. A write failure from a full disk sets
  `status: degraded` and stops advancing cursors rather than corrupting them.
- **Growth:** a few MB/year. No partitioning, archiving or vacuum schedule is needed; the prune jobs
  bound the only two tables that grow with activity.
- **Cost:** €0.
