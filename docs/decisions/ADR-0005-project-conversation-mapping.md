# ADR-0005: Own the project registry in the Gateway and bind one active conversation per (chat, project)

## Status

Proposed

| Field | Value |
| --- | --- |
| Date proposed | 2026-10-08 |
| Date decided | — |
| Decided by | — |
| Related Issue | [#1](https://github.com/eliangilsierra/openhands-mobile-gateway/issues/1) |
| Supersedes | None |
| Related ADRs | ADR-0001 (topology), ADR-0003 (store), ADR-0006 (event stream) |

## Context

FR-4 requires `/projects` and `/use <project>`, with an active project per chat. NFR-6 requires
several projects per user, each with its own conversation, persisted across restarts. FR-8 and
AC-9/AC-10 require that a message sent tomorrow continues today's conversation. The person's
`/projects` directory (the `canvas-projects` volume) holds `toneprofiler`, `code-sentinel`,
`clinical-labs`, `openhands-agent-team` and others.

OpenHands offers much less than the Issue's open question Q-6 assumed:

- `StartConversationRequest.workspace` is a `LocalWorkspace` whose only required field is
  `working_dir: str`, an absolute path. There is **no** `project`, `repository` or workspace-id field
  (R3-F1).
- The server generates a fresh `conversation_id` per conversation and applies **no uniqueness
  constraint** between a `working_dir` and a conversation, so one directory can back many
  simultaneous conversations. OpenHands therefore does **not** track "the active conversation for
  this project" — that bookkeeping belongs to the caller (R3-F3, R3-I1).
- There is **no "list my repos/projects" endpoint**. `GET /api/workspaces` is a GUI-maintained,
  file-backed list populated only by explicit `POST /api/workspaces` calls, with no filesystem
  scanning — so it is empty unless the person already added those folders through the Canvas UI
  (R2-F16, R3-F4, R3-F5, R2-I2).
- What does exist is `GET /api/file/search_subdirs?path=<absolute>`, a generic endpoint returning the
  immediate subdirectories of any path the agent-server can read, as **absolute paths** intended to
  be used directly as `workspace.working_dir` (R3-F6). Verified in this stage (**V-4**): the real
  path is `GET /api/file/search_subdirs` (`file_discovery_router` has prefix `/file` and is mounted
  under `/api`) at agent-server 1.49.6.
- Research recommendation R-1 proposed a Gateway-side static registry as the primary mechanism, with
  `search_subdirs` as an optional secondary, at **medium** confidence — the stated reason being that
  parity with the deployed image was unverified.

Two things must be decided together, because they are the same mapping problem: **where the list of
selectable projects comes from**, and **how a chat, a project and a `conversation_id` relate**. Both
are expensive to reverse: they define the SQLite schema (ADR-0003), the `/projects` and `/use` user
experience, and the Gateway's only path-handling attack surface.

## Decision

### 1. The Gateway owns the project registry, resolved in this order

1. If the environment variable **`PROJECTS`** (a comma-separated list of names) is set, it is
   authoritative. Nothing is discovered.
2. Otherwise, call **`GET /api/file/search_subdirs?path=${PROJECTS_ROOT}`** (default `/projects`) and
   use the returned absolute paths.
3. If step 2 returns 404 or 501 (version skew), fall back to **`GET /api/workspaces`**.
4. If that is empty or fails, reply with an actionable error telling the person to set `PROJECTS`.

Results from step 2/3 are cached in memory for 60 seconds. The Gateway **mounts no volume** — not
`canvas-projects`, not anything else.

This **overrides research recommendation R-1's ordering** (which put the static registry first).
Justification: R-1's medium confidence rested on unverified parity with the deployed image, and
**V-4** removes that doubt by confirming the endpoint at exactly the agent-server version the image
pins (1.49.6, R1-F13). Reading the *server's* view of the directory is strictly better than the
Gateway reading its own, because (a) it needs no mount of `canvas-projects`, which is the strongest
possible compliance with FR-10 and eliminates the Gateway's filesystem attack surface entirely, (b)
the paths returned are exactly the paths the server will accept as `working_dir`, so there is no
class of "the Gateway can see it but the agent cannot" bug, and (c) new projects appear without a
redeploy. The static list is retained as an override and a fallback, so the person always has an
escape hatch.

### 2. Every user-supplied project key is validated by three independent controls

Applied in order, before any path is used:

1. Match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` — rejects `/`, `..`, `~`, `$`, backticks, NUL, newlines
   and leading dots.
2. Reject the literals `.` and `..`.
3. Resolve **by set membership** against the list from step 1/2/3 above. The Gateway **selects** an
   entry the registry already produced; it never **constructs** a path from the user's string. Then
   assert the selected absolute path equals `PROJECTS_ROOT + "/" + <single segment>`.

An unknown key yields `⚠️ Proyecto no encontrado. Usa /projects para ver la lista.` — no path is
disclosed.

### 3. The mapping model is one active conversation per (channel, chat, project)

- `chat_state(channel, external_chat_id) → active_project` holds the current selection; free text is
  routed to the active project's conversation (FR-4).
- `conversation_binding(channel, external_chat_id, project_key) → conversation_id`, with
  `state ∈ {active, stale, closed}` and a uniqueness constraint over the active triple (ADR-0003 §8).
- On free text: look up the active binding. If one exists and is `active`, **reuse it** —
  `POST /api/conversations/{id}/events` (R2-F6). This is what makes AC-9 and AC-10 work; multi-day
  continuity is simply "do not create a new conversation".
- If none exists, create one with
  `POST /api/conversations {workspace:{working_dir}, initial_message}` (R2-F3) and store the binding.
- `/use <project>` only switches `active_project`; it never creates or destroys a conversation, and
  it reports whether an existing conversation was resumed or none exists yet.
- `/stop` maps to `POST /api/conversations/{id}/interrupt` and **does not delete** the conversation,
  precisely because FR-8/AC-10 require continuity. The reply says so explicitly.
- A 404 from OpenHands on a stored `conversation_id` marks the binding `stale`; the next message
  creates a fresh conversation and the user is **told the history was lost** rather than silently
  losing context.
- Switching projects does not cancel work: a paused or running conversation in another project keeps
  its binding and its event subscription lifecycle (ADR-0006).
- `worktree: true` (R3-F2) is **not** used. No requirement asks for per-conversation git worktrees,
  and it would change the agent's working directory in a way the person has not asked for.
- There is deliberately **no `/new`** command in V1 (no requirement asks for one). If context growth
  becomes a problem, that is the natural answer and a small addition.
- Channel identity is stored as an opaque `(channel, external_chat_id)` pair, never as "Telegram chat
  id", so a second channel reuses the same tables (NFR-8).

## Alternatives

| Alternative | Summary | Why not chosen |
| --- | --- | --- |
| **Static registry only (research R-1a, no discovery call)** | `PROJECTS=toneprofiler,code-sentinel,...` in the environment; paths built as `PROJECTS_ROOT/<name>`. | The simplest option and genuinely viable — it is retained as step 1 and as the fallback. Rejected as the *default* because adding a project would require an environment change and a redeploy, and because a typo in the list produces a `working_dir` the agent cannot use, with no way for the Gateway to notice. **V-4** made the discovery path dependable enough that this cost is unnecessary. |
| **Mount `canvas-projects` read-only into the Gateway and list the directory itself (research R-1a variant)** | The Gateway reads `/projects` directly. | Rejected: it gives the Gateway a filesystem view of the canvas's own volume — against the spirit of FR-10 — and introduces a real path-traversal surface where today there is none. The equivalent information is available over the API with no mount. |
| **`GET /api/workspaces` as the primary source** | Use the GUI's saved-workspaces list. | Rejected as primary: it is operator-curated and populated only by explicit `POST /api/workspaces` calls with no filesystem scan (R3-F4, R3-F5), so it is very likely empty on this installation and would make `/projects` show nothing. Retained as step 3 because when it *is* populated it is a legitimate, intentional list. |
| **Register each project as a workspace via `POST /api/workspaces` on first use** | Have the Gateway populate the canvas's workspace picker. | Rejected: it writes state into `agentcanvas`, changing what the person sees in the browser UI as a side effect of a Telegram command. That is a surprising, unrequested mutation of someone else's data; FR-10's spirit says no. |
| **One conversation per chat, shared across all projects** | A single conversation; `/use` just changes the `working_dir` of the next message. | Rejected: `working_dir` is fixed at conversation creation (R3-F1), so this is not even possible without forking; and it would mix unrelated project contexts in one agent history, which fails NFR-6 and would degrade the agent's output. |
| **A new conversation per task (no reuse)** | Every free-text message starts fresh. | Rejected outright: directly violates FR-8, AC-9 and AC-10, which are the requirements that motivated persistence in the first place. |
| **Many concurrent conversations per project, user-selectable** | Let the owner keep several threads per project and pick one. | Technically supported upstream (R3-I1 confirms a directory can back many conversations) and arguably nicer, but **no requirement asks for it**, and it would need a conversation-picker UI, listing, naming and garbage collection. Rejected as unrequested complexity; `/new` plus a picker is the obvious future extension if it is ever wanted. |
| **Derive the mapping from OpenHands by searching conversations** | On each message, `GET /api/conversations/search` and pick the newest one whose workspace matches. | Rejected: `ConversationInfo` would have to expose the workspace reliably, the search is paginated and unindexed by path, it is O(conversations) per message, and it cannot distinguish "the conversation this chat was using" from "any conversation in that directory" — including ones the person started in the browser. It would also make correctness depend on server-side ordering. The mapping is cheap to own (ADR-0003) and unambiguous when we do. |

## Consequences

**Positive**

- `/projects` reflects reality with no configuration and no redeploy, and the paths it offers are
  exactly the paths the agent will accept.
- The Gateway mounts **no volume at all**, so there is no path-traversal surface on its own
  filesystem and no possibility of it touching `claude-home` or corrupting `canvas-projects`.
- FR-8/AC-9/AC-10 fall out naturally: "reuse the binding" is the whole of multi-day continuity.
- The data model is three small tables and one rule, understandable and testable; `(channel,
  external_chat_id)` opacity keeps NFR-8 satisfied at no cost.
- The static `PROJECTS` override means the person is never blocked by a discovery failure.

**Negative**

- `/projects` depends on an OpenHands endpoint that is not a published public contract — a real
  coupling, mitigated by the two fallbacks and the 60 s cache, and bounded to one function.
- `search_subdirs` lists *all* immediate subdirectories of `PROJECTS_ROOT`, including anything that
  is not actually a project. Accepted: the person's `/projects` is already a project directory, and
  `PROJECTS` exists to narrow it.
- One conversation per (chat, project) means parallel threads on the same project are impossible in
  V1. Accepted and documented.
- A conversation that lives for months accumulates context indefinitely. OpenHands owns context
  management (condensation is a server-side feature); the Gateway must **not** try to manage it.
  Recorded as a risk in architecture §20, with `/new` as the answer if it materialises.
- A stale binding surfaces as a user-visible "history lost" message. Chosen deliberately over
  silently starting fresh.

**Follow-up actions**

- The person runs `V-C7` (`GET /api/file/search_subdirs?path=/projects`) and `V-C8`
  (`GET /api/workspaces`) from architecture §21 to confirm what each returns on the live instance. If
  V-C7 fails, step 1 (`PROJECTS`) becomes the deployment default and this ADR needs no change.
- Work package 6 implements the registry, the three validation controls and their adversarial unit
  tests; work package 7 implements create-or-reuse.

## Security considerations

This ADR owns the Gateway's **only** user-controlled-string-to-filesystem-path flow, and therefore
its most dangerous attack surface.

- **Path traversal (threat T-B2-3).** A naive implementation of `/use` would let
  `/use ../../home/openhands/.claude` point the agent at the Claude credentials directory — the worst
  realistic outcome in this system. Three independent controls prevent it (decision §2), and the
  decisive one is **set membership**: the user's string selects a registry entry rather than building
  a path. Required unit tests (NFR-9): `..`, `../..`, URL-encoded `%2e%2e%2f`, absolute paths
  (`/etc`), backslash variants, NUL and newline injection, a 1000-character key, Unicode
  look-alikes, and a name that matches the regex but is absent from the registry.
- **Command injection (threat T-B2-4):** structurally impossible here — the Gateway spawns no
  subprocess and builds no shell string (lint-enforced, ADR-0001). Project names reach OpenHands only
  as a JSON string field.
- **SQL injection (threat T-B3-1):** project keys reach the store exclusively as bound parameters.
- **Information disclosure (threat T-B1-2):** an unknown project yields a fixed message with no path;
  absolute paths are `DEBUG`-only log fields (NFR-5). `/projects` does disclose the *names* of the
  person's project directories — acceptable, since only the allowlisted owner can ever see it (FR-7).
- **Cross-chat access:** a binding is keyed by `(channel, external_chat_id, project_key)`, so one
  chat can never resolve another chat's `conversation_id`. With a single allowlisted owner this is
  defence in depth rather than a live control, but it keeps the model correct if the allowlist ever
  holds more than one person.
- **No write to `agentcanvas` state:** the Gateway never calls `POST /api/workspaces`, so a Telegram
  command cannot alter what the browser UI shows.
- **Residual:** anyone on the allowlist can direct the agent at any project in `PROJECTS_ROOT`. That
  is the intended capability, not a flaw; the allowlist is the control.

## Operational considerations

- **Configuration:** `PROJECTS_ROOT` (default `/projects`) and optional `PROJECTS`. Both documented
  in `.env.example`. No volume mount, no path to keep in sync with `agentcanvas`.
- **Day-2 behaviour:** a new directory under `/projects` appears in `/projects` within 60 seconds (the
  cache TTL) with no redeploy. A removed directory disappears; an existing binding to it becomes
  `stale` on the next use and is reported.
- **Debugging:** log events `project.selected`, `conversation.created`, `conversation.reused`, each
  with `project_key` and `conversation_id`, so a mapping problem can be traced in one `grep`. The
  `conversation_id` ties directly into the browser UI, where the same conversation's full raw history
  is visible.
- **Recovery:** if `gateway.db` is lost (ADR-0003), the conversations still exist in `canvas-state`.
  Re-binding is manual: the person finds the conversation in the browser UI. V1 offers no
  `/bind <conversation_id>` command — noted as a possible small addition if this ever happens.
- **Cost:** €0. One cached HTTP call per minute at most.
