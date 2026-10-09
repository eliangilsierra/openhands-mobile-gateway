# ADR-0006: Consume OpenHands events over the agent-server WebSocket with timestamp replay and client-side deduplication by event id

## Status

Accepted

| Field | Value |
| --- | --- |
| Date proposed | 2026-10-08 |
| Date decided | 2026-10-08 |
| Decided by | @eliangilsierra (owner, via PR #2) |
| Related Issue | [#1](https://github.com/eliangilsierra/openhands-mobile-gateway/issues/1) |
| Supersedes | None |
| Related ADRs | ADR-0001 (topology), ADR-0002 (`ws`, not the bundled socket client), ADR-0003 (cursor storage), ADR-0005 (which conversations are subscribed) |

## Context

NFR-3 is the hardest reliability requirement in Issue #1: the connection to OpenHands *"shall
automatically reconnect on disconnect with exponential backoff …; shall recover or deduplicate
missed events, and preserve event ordering; shall not 'die' silently on disconnect."* AC-14 makes it
testable: after a drop following events E1–E3, the Gateway must *"replay, deduplicate, or skip
E1/E2/E3 consistently, resume from E4 onward, and preserve event order"*. FR-2 and AC-3 require the
raw event stream to be translated into a small set of human-readable messages, not a firehose.
Issue risk R-4 flagged that if OpenHands has no offset-based replay, events could be lost.

What research and this stage established about the real mechanism:

- The event socket is a **plain FastAPI/Starlette WebSocket**, not Socket.IO, at
  `ws://host:8000/sockets/events/{conversation_id}` — mounted on the app root, not under `/api`
  (R2-F20). **V-1** confirms `/sockets` is proxied through port 8000 by the canvas ingress, so it is
  reachable from the Docker network.
- Three authentication methods exist, in precedence order: a **first text frame**
  `{"type":"auth","session_api_key":"…"}` (recommended, 10 s timeout), a deprecated
  `?session_api_key=` query parameter, and an `X-Session-API-Key` header. Failure closes with code
  **4001** (R2-F21).
- A **`resend_mode` query parameter** exists: `all` replays every stored event before going live;
  `since` (with `after_timestamp`, ISO 8601) replays events at or after that timestamp (R2-F22).
  Recovery is therefore **timestamp-based, not offset- or sequence-based** — no "events after id X"
  primitive was found (R2-I5).
- The frames are plain serialised `Event` objects, identical in shape to the REST event-search
  response, with a `kind` discriminator and base fields `id`, `timestamp`, `source`, `parent_id`
  (R2-F24, R2-F25).
- The same catch-up is available over HTTP:
  `GET /api/conversations/{id}/events/search?timestamp__gte=…` (R2-F10, R2-F23) — two independent
  recovery paths.
- Event kinds relevant to translation: `MessageEvent` (R2-F26), `SystemPromptEvent` (R2-F27,
  suppress), `ActionEvent` with `thought`, `tool_name`, `security_risk` and an LLM-authored
  ~10-word `summary` explicitly designed for human rendering (R2-F28), `ObservationEvent` (R2-F29),
  `UserRejectObservation` (R2-F30), `AgentErrorEvent` (R2-F31). There is **no** dedicated
  "confirmation needed" event; `waiting_for_confirmation` is a conversation-level status (R2-F13,
  R2-F32).
- Exact field names inside tool-specific `action`/`observation` payloads were **not** resolved
  (R2-U1); R2-R5 recommends keying on `ActionEvent.summary` and `tool_name` instead.
- Verified in this stage (**V-6**): the official client's bundled `WebSocketCallbackClient` connects
  with the **deprecated query-parameter auth** and has **no `resend_mode`/`after_timestamp`
  support**. It cannot satisfy NFR-3.

This is expensive to reverse: it determines the durable cursor schema, the delivery guarantee the
whole user experience rests on, and whether AC-14 can pass at all.

## Decision

We will consume events over the agent-server WebSocket using a **Gateway-owned subscriber** built on
`ws` (ADR-0002), with these properties:

1. **Endpoint and auth.** Connect to `ws://agentcanvas:8000/sockets/events/{conversation_id}` and
   send `{"type":"auth","session_api_key":"<key>"}` as the **first text frame**. The query-parameter
   form is **not** used, because it would put the credential in a URL that the ingress proxy may log.
   The bundled `WebSocketCallbackClient` is **not** used (**V-6**).
2. **Replay on connect.** First subscription with no stored cursor: `?resend_mode=all`. Every
   reconnect, and every subscription with a cursor: `?resend_mode=since&after_timestamp=<cursor>`,
   where the cursor is the `timestamp` of the last event durably recorded for that conversation.
3. **Deduplication by `event.id`, never by timestamp.** Every received event is checked against the
   `seen_event` table (ADR-0003) keyed by `(conversation_id, event_id)`. Replayed duplicates are
   dropped and logged as `event.deduped`. This is the control that makes AC-14 pass despite
   timestamp-granularity ambiguity (R2-I5).
4. **Ordering.** Events for one conversation are processed through a **single-consumer in-process
   queue**, so translation and sending preserve arrival order. No per-event concurrency.
5. **Durability ordering.** The cursor advance and the `seen_event` insert happen in the **same SQLite
   transaction**, and only **after** the resulting notification has been handed to the outbound
   queue. A crash therefore re-delivers an event (at-least-once, deduped on restart) rather than
   losing it. **The delivery guarantee is explicitly at-least-once with deduplication, not
   exactly-once** — exactly-once is impossible with timestamp-based replay.
6. **Backoff.** Reconnect with exponential backoff and **full jitter**: 1 s base, ×2, 60 s cap,
   unlimited attempts while the conversation is active.
7. **Auth failure is not retried blindly.** After two consecutive `4001` closes the subscriber stops,
   `openhands.auth_failed` is logged, `/health` reports `degraded` with `api_key: rejected`, and the
   user is told once.
8. **"Not dying silently" is implemented concretely** (NFR-3): every close is logged with its code,
   every retry logs `ws.reconnect_scheduled` at `INFO`, every replay logs `ws.replay_requested` with
   the cursor, and three consecutive failures set `openhands_api: unreachable` in `/health`.
9. **REST fallback.** After `WS_FAIL_THRESHOLD` (3) consecutive failures to open the socket, degrade
   to polling `GET /api/conversations/{id}/events/search?timestamp__gte=<cursor>` every
   `EVENT_POLL_SECONDS` (default 5), with identical dedup and ordering, while continuing to retry the
   socket in the background. The two paths share one code path downstream of "here is an event".
10. **Subscription lifecycle.** A socket is opened when a conversation becomes active (a task is
    sent, or `/status` finds it non-terminal) and closed after `WS_IDLE_SECONDS` (default 900) once
    the conversation reaches a terminal status (`finished`, `error`, `stuck` — R2-F13). This bounds
    live sockets to recently used projects rather than all bindings ever created, and is the lever
    §13 of the architecture document pulls at 10× load.
11. **Translation is a pure function** `OpenHandsEvent → Notification[]` in `src/core/translate.ts`,
    channel-agnostic: the kind-to-meaning mapping lives here, while emoji and formatting live in the
    channel adapter (NFR-8). Initial taxonomy: `SystemPromptEvent` → suppressed;
    `MessageEvent` from the agent → the message text; `ActionEvent` → `summary` if present, else
    `tool_name` (R2-R5, deliberately avoiding R2-U1's unresolved per-tool field names);
    `ObservationEvent` → suppressed by default except for failures; `UserRejectObservation` →
    "acción denegada"; `AgentErrorEvent` → the error. Unknown `kind` values are **suppressed and
    counted**, never rendered as raw JSON — forward compatibility by default.
12. **Confirmations.** Because there is no confirmation event (R2-F32), the trigger is: an
    `ActionEvent` arrives **and** the conversation status is `waiting_for_confirmation`. A
    confirmation policy is set at conversation creation via
    `POST /api/conversations/{id}/confirmation_policy` (R2-F9; exact body to be read from the live
    `/openapi.json`). The inline keyboard's `callback_data` carries only an opaque
    `pending_confirmation` row id, because of the 64-byte limit (R3-E2).
13. **Coalescing is part of this decision, not an optimisation.** Consecutive progress notifications
    for one conversation are merged into a single "live status" message updated with
    `editMessageText`; terminal, error and confirmation events always get their own message. Without
    this, Telegram's ≈1 message/second per-chat limit (R3-F10) would turn a busy task into a growing
    backlog — and FR-2 explicitly asks for "not a firehose".

## Alternatives

| Alternative | Summary | Why not chosen |
| --- | --- | --- |
| **REST polling only (`events/search?timestamp__gte=…`), no WebSocket** | Poll every few seconds; no socket to manage. | The simplest option, and it is retained as the degraded fallback (decision §9). Rejected as the primary because FR-1/AC-1 want status flowing "within 2 seconds" and AC-3 wants live progress; polling every 5 s adds avoidable latency, and polling every 1 s would hammer the agent-server and compete with the browser UI (threat T-B2-6). It also does not satisfy NFR-3's intent, which plainly describes a push connection. |
| **The official client's `WebSocketCallbackClient`** | Use the socket client shipped in `@openhands/typescript-client`. | Rejected on verified grounds (**V-6**): it offers no `resend_mode`/`after_timestamp`, so **AC-14 could not pass** — a reconnect would silently skip everything that happened while disconnected; and it authenticates with the deprecated query parameter, putting the API key where the ingress proxy can log it. Its backoff is useful but trivial to reproduce. We still use the package for REST (ADR-0002). |
| **`resend_mode=all` on every reconnect** | Always replay the whole history and rely on dedup. | Correct but wasteful and unbounded: a multi-day conversation (which FR-8/AC-10 explicitly encourage) would replay thousands of events on every network blip, and the `seen_event` table would have to retain all of them to avoid re-sending. Used only for the first subscription with no cursor. |
| **No dedup; trust `after_timestamp` to be exact** | Simpler: just resume from the cursor. | Rejected: recovery is timestamp-based with no documented granularity guarantee, so two same-millisecond events can be re-delivered or skipped (R2-I5). AC-14 demands *consistent* handling. Dedup by `event.id` is a few lines and an index. |
| **Dedup by a content hash instead of `event.id`** | Hash the serialised event. | Unnecessary: every `Event` carries a unique `id` (R2-F25). A hash would be slower, bigger and would conflate legitimately identical events. |
| **Mirror the full event stream into SQLite and render from there** | Keep a local copy of all events. | Rejected: it duplicates OpenHands' own event store (against G-2), grows without bound, and turns a privacy-light database into one holding full task content (ADR-0003 deliberately stores none). The cursor plus a bounded `seen_event` set is all the state the guarantee needs. |
| **Parse tool-specific `action`/`observation` payloads for rich messages** (e.g. exact file paths) | Nicer output: "🔧 Modificando: src/file.ts". | Deferred, not rejected in principle. The exact field names are unresolved (R2-U1) and are generated per tool from JSON schema, so hand-parsing now would be guesswork that breaks on any tool change. `ActionEvent.summary` is an LLM-authored human description built for this purpose (R2-F28, R2-R5). Per-tool refinement is a later, additive change inside one pure function. |
| **Subscribe to every bound conversation permanently** | Keep a socket open for every binding. | Rejected: sockets would grow with history rather than activity, for no benefit — a conversation nobody is watching produces no events worth pushing. Idle teardown (§10) is both simpler and the scalability lever. |

## Consequences

**Positive**

- NFR-3 and AC-14 are satisfiable with a precisely stated guarantee: **at-least-once with
  deduplication by `event.id`, order preserved per conversation**. That sentence is the testable
  contract.
- Two independent recovery paths (socket replay and REST search) mean a broken WebSocket degrades the
  experience rather than breaking it.
- "Never dies silently" is a set of concrete, greppable log events and health transitions, not an
  aspiration.
- Keying translation on `ActionEvent.summary`/`tool_name` means the translator can be built and
  shipped **without** resolving R2-U1 — the project's largest remaining unknown stops being a
  blocker.
- Suppressing unknown `kind` values makes an OpenHands upgrade that adds event types a non-event
  instead of a wall of raw JSON in the chat.
- Coalescing keeps the Gateway inside Telegram's per-chat rate limit by construction.

**Negative**

- **Exactly-once delivery is impossible** and is explicitly not offered. In a same-millisecond edge
  case two events can be reordered relative to each other within one coalesced batch. Documented in
  architecture §17 rather than engineered around.
- The Gateway hand-maintains a WebSocket client (connect, auth frame, replay parameters, backoff,
  teardown) — the most intricate code in the project and the place most likely to harbour bugs.
  Mitigated by making it the explicit subject of integration tests (work package 8 / NFR-9: kill the
  socket mid-stream, assert replay, dedup, order and resumption).
- A dependency on `resend_mode`, an internal query parameter with no compatibility promise. If an
  upgrade removes it, the Gateway degrades to the REST path — a real, designed-for fallback.
- Translation is lossy by design (FR-2). The person will sometimes want detail the chat does not
  show; the answer is the browser UI, which still has the full raw history for the same
  `conversation_id`. The Gateway must say so in `/help`.
- Coalescing via `editMessageText` means the chat history shows one evolving status message rather
  than a full transcript — a deliberate UX trade for FR-2.

**Follow-up actions**

- Resolve the exact body of `POST /api/conversations/{id}/confirmation_policy` from the live
  `/openapi.json` (architecture §21, V-C5) before implementing work package 12.
- Optionally revisit R2-U1 later to enrich per-tool messages; purely additive inside
  `src/core/translate.ts`.
- Work package 8 and 9 implement the subscriber and the translator; the AC-14 integration test is a
  release gate.

## Security considerations

- **Credential handling is the main security content of this ADR.** First-message authentication is
  chosen specifically so the API key never appears in a URL, where the canvas's ingress proxy or any
  intermediary could log it (threat T-B2-2). This is a deliberate deviation from the official
  client's behaviour (**V-6**) and is the main reason that client is not used for the socket.
- **Auth-failure handling avoids a self-inflicted denial of service:** stopping after two `4001`
  closes prevents a reconnect storm against `agentcanvas` when the key is wrong, and surfaces the
  real problem (`openhands.auth_failed`) instead of burying it in retries.
- **Untrusted input.** Event payloads are **data, not instructions**: they originate from an agent
  that reads repository content, so they can contain anything — including text engineered to look
  like a Gateway command or Telegram markup. Controls: event shape is validated (`zod`) before the
  translator reads it; unknown kinds are suppressed; agent-produced text is sent to Telegram with
  **no `parse_mode`**, so it cannot forge or break Gateway-authored markup (threat T-B1-6); the
  translator never evaluates, executes or interprets event content; nothing from an event is ever
  used to choose an endpoint, a path or a conversation id.
- **Resource exhaustion:** a notification body is capped and chunked (architecture §7.6); the
  `seen_event` table is pruned (ADR-0003); live sockets are bounded by idle teardown and
  `MAX_ACTIVE_SUBSCRIPTIONS`; a hostile or runaway event burst therefore cannot exhaust memory or
  disk (threat T-B2-6).
- **No new trust boundary** is created: the socket crosses the same B2 boundary as the REST calls,
  with the same credential and the same plaintext-on-the-Docker-bridge posture (ADR-0001).
- **Audit:** `confirmation.presented` and `confirmation.answered` (with the decision) are logged, and
  `pending_confirmation` records it durably, so an Allow/Deny is attributable (threat T-B1-5). A
  confirmation callback is accepted only if the row is unresolved and belongs to the tapping user's
  chat (threat T-B1-3).
- **Secrets never appear in event logs:** `event.received`/`event.translated` log `event_id`, `kind`
  and `conversation_id` only — never `content` (NFR-5, AC-16).

## Operational considerations

- **Configuration:** `WS_IDLE_SECONDS` (900), `WS_FAIL_THRESHOLD` (3), `EVENT_POLL_SECONDS` (5),
  `SEEN_EVENT_KEEP` (2000), `MAX_ACTIVE_SUBSCRIPTIONS`, `CONFIRMATION_TTL_SECONDS` (3600). All have
  working defaults; none needs tuning for a single user.
- **Monitoring:** `ws.connected`, `ws.closed` (with code), `ws.replay_requested` (with cursor),
  `ws.reconnect_scheduled`, `event.received`, `event.deduped`, `event.suppressed`,
  `event.translated`. Repeated `ws.reconnect_scheduled` is the signal that something is wrong;
  `openhands.auth_failed` is the one that needs a human.
- **Health:** three consecutive socket failures set `openhands_api: unreachable` and
  `status: degraded` (NFR-4). `details.active_subscriptions` exposes the live socket count.
- **Debugging a lost update end to end:** the `request_id` on the originating task plus the
  `conversation_id` on every event line; `event.deduped` versus `event.suppressed` distinguishes "we
  saw it and dropped it as a duplicate" from "we saw it and chose not to show it" — the two questions
  that actually get asked. The browser UI shows the authoritative raw history for the same
  conversation.
- **Restart behaviour:** on boot, any binding in state `active` whose conversation is non-terminal is
  re-subscribed with `resend_mode=since` from its stored cursor, so a redeploy mid-task resumes
  rather than losing the thread.
- **Cost:** €0. One WebSocket per recently active conversation; negligible CPU.
