# ADR-0002: Implement the Gateway in TypeScript on Node.js, with grammY and the official OpenHands TypeScript client

## Status

Accepted

| Field | Value |
| --- | --- |
| Date proposed | 2026-10-08 |
| Date decided | 2026-10-08 |
| Decided by | @eliangilsierra (owner, via PR #2) |
| Related Issue | [#1](https://github.com/eliangilsierra/openhands-mobile-gateway/issues/1) |
| Supersedes | None |
| Related ADRs | ADR-0001 (topology), ADR-0003 (store), ADR-0004 (Telegram transport), ADR-0006 (event stream) |

## Context

ADR-0001 decides the Gateway is a thin HTTP/WebSocket client in its own container. A language,
runtime and the two libraries that define its shape must be chosen. This is expensive to reverse:
it fixes the toolchain, the container base image, the test framework, the hiring/maintenance profile
and — through the API client — the way the Gateway couples to OpenHands.

Forces:

- **NFR-10** states a soft preference, explicitly overridable with justification: *TypeScript/Node.js*.
- The workload is almost entirely **I/O concurrency**: one long-poll loop to Telegram, N WebSockets
  to the agent-server, a trickle of SQLite writes, and per-chat paced outbound sends. There is no CPU
  work: no model inference, no parsing of large payloads, no image or video handling.
- **NFR-2** forbids new infrastructure and cost; the runtime must be free and must run as one
  container on an existing VPS with no extra services.
- **FR-9** requires a Docker image with a non-root user and a healthcheck, deployable through the
  existing Coolify + GitHub flow.
- **NFR-9** requires unit tests (authorization, mapping, event translation, chunking, config
  validation) and integration tests against a **mocked** OpenHands API, including WebSocket
  reconnect and replay. The ecosystem must make an in-process HTTP + WS mock easy.
- The three mainstream Node Telegram libraries (grammY, Telegraf, `node-telegram-bot-api`) all
  support long polling with no public endpoint and webhook mode behind Express/Fastify; library
  maturity is **not** a differentiator (R3-F11, R3-F12, R3-F13, R3-I3).
- Verified in this stage (**V-5**): `@openhands/typescript-client` is published on npm under MIT and
  version **1.49.6** exists — exactly the agent-server version pinned inside the deployed image
  (R1-F13). It ships typed REST clients (`pauseConversation`, `interruptConversation`,
  `runConversation`, `sendEvent`, `searchEvents`, `setConfirmationPolicy`, `countConversations`, …),
  generated schema types, and subpath exports. Its own dependencies are `ws` and `@openrouter/sdk`,
  with the OpenRouter code confined to `dist/llm/*`.
- Also verified (**V-6**): that package's bundled `WebSocketCallbackClient` connects using the
  deprecated `?session_api_key=` query parameter and has **no** `resend_mode`/`after_timestamp`
  support, so it cannot satisfy NFR-3 (see ADR-0006).

## Decision

We will **confirm NFR-10's preference**: implement the Gateway in **TypeScript (strict mode) on
Node.js 22 LTS**, ESM, with these direct dependencies and no others without a new decision:

| Dependency | Role | Licence |
| --- | --- | --- |
| `grammy` | Telegram Bot API client and long-polling runner | MIT |
| `@openhands/typescript-client` **pinned to `1.49.6`** | typed REST client for the agent-server | MIT (**V-5**) |
| `ws` | the Gateway's own WebSocket layer (see below) | MIT |
| `better-sqlite3` **or** `node:sqlite` | SQLite access (ADR-0003) | MIT / built-in |
| `zod` | boot-time configuration validation and event-shape guards | MIT |

Plus development-only: `typescript`, `vitest`, `eslint`, `@types/*`.

Details that make this unambiguous:

1. **The REST layer uses the official client, not hand-written `fetch` calls.** It is the same
   version the canvas frontend itself depends on, so its request shapes track the server's. It is
   wrapped by `src/openhands/rest.ts`, which owns the base URL, the `X-Session-API-Key` default
   header, the timeouts and the error mapping — so the rest of the codebase never touches the
   vendor types directly and the client can be swapped out behind that one module.
2. **The WebSocket layer is ours, built on `ws`.** `WebSocketCallbackClient` is not used, because it
   lacks `resend_mode` and uses query-parameter auth (**V-6**). ADR-0006 specifies the replacement.
3. **Only client subpaths are imported** (`./clients`, `./client/*`). `dist/llm/*` is never imported,
   so `@openrouter/sdk` code never executes — important because NFR-2 forbids any LLM provider usage.
   A lint rule (`no-restricted-imports`) enforces this, alongside the ban on `child_process` from
   ADR-0001.
4. **Node 22 built-ins replace libraries wherever possible:** `fetch` for the two plain HTTP probes,
   `node:http` for the `/health` listener (no Express/Fastify — nothing needs a web framework when
   there is exactly one unauthenticated GET route), `node:test`-style structure under `vitest`, and
   `AbortSignal.timeout` for request deadlines.
5. **Container:** multi-stage build on `node:22-alpine` (`npm ci` → `tsc` → runtime stage with
   production dependencies only), `USER node`, explicit SIGTERM handling that stops polling, drains
   the per-chat send queues and closes SQLite.
6. **Fallback if the client proves unusable** (for example, the deployed server turns out not to be
   1.49.6, or `npm audit` flags `@openrouter/sdk` unacceptably): replace `src/openhands/rest.ts`'s
   internals with plain `fetch` calls against the same 15 routes. This is a contained, one-module
   change and does **not** require superseding this ADR.

## Alternatives

| Alternative | Summary | Why not chosen |
| --- | --- | --- |
| **Python 3 (FastAPI/httpx + `python-telegram-bot`)** | Match the language OpenHands itself is written in. | Tempting because the agent-server is Python, but the Gateway never imports OpenHands' Python code (ADR-0001 rejects that explicitly), so the shared language buys nothing concrete. It would mean discarding NFR-10's stated preference, and the SQLite/async story is no better for this workload. Rejected — no justification strong enough to override a stated preference. |
| **TypeScript with hand-written `fetch` calls instead of `@openhands/typescript-client`** | Fewer dependencies; total control. | Credible, and kept as the documented fallback above. Rejected as the default because the official client is MIT, pinnable to the exact server version, and carries generated types for the request/response shapes — which measurably reduces the "invented endpoint / wrong body shape" risk that is this project's main technical hazard. Its cost (one transitive LLM SDK in the tree, never executed) is smaller than that benefit. |
| **Telegraf or `node-telegram-bot-api` instead of grammY** | Equivalent Telegram libraries. | A genuine coin-flip: all three support long polling with no public endpoint and webhook mode later (R3-I3). grammY is chosen for its first-party TypeScript types, its explicit maintainer guidance that long polling has "no major drawbacks" absent a reason for webhooks (R3-F11, which underpins ADR-0004), and its small dependency set. Rejected without prejudice — swapping is a contained change inside `src/channels/telegram/`. |
| **Deno or Bun** | Modern runtimes with built-in TypeScript and SQLite. | Attractive on paper (no build step, built-in SQLite), but Coolify/Docker familiarity, the Telegram and OpenHands client libraries' testing matrices, and the person's stated preference all point at Node. No requirement needs their advantages. Rejected. |
| **Go or Rust** | Single static binary, tiny image, excellent WebSocket story. | Would reduce image size and memory, neither of which any NFR constrains. Costs: no official OpenHands client, so every request shape is hand-written (the exact risk we are trying to reduce), and it discards NFR-10. Rejected. |
| **A web framework (Express/Fastify) for `/health`** | Conventional. | One unauthenticated GET route does not justify a framework and its dependency tree; `node:http` is ~20 lines. Rejected on NFR-2's "avoid unnecessary infrastructure" spirit. If ADR-0004 is ever revisited in favour of webhooks, this is worth reopening. |

## Consequences

**Positive**

- Matches the stated preference, so no justification debt and no surprise for the person maintaining
  it.
- Excellent fit for an I/O-bound, single-process workload; one event loop handles the poll loop, N
  sockets and the paced sends without threads or a queue.
- The official client's generated types turn "did I get the request body right?" from a runtime
  surprise into a compile error, which is the single biggest risk in ADR-0001.
- Small, auditable dependency surface (5 direct runtime packages, all MIT), a committed lockfile, and
  a non-root Alpine image.
- `vitest` plus an in-process `node:http` + `ws` mock makes every NFR-9 integration scenario
  (create, send, receive, reconnect, replay, pause/resume, confirmation) testable without Docker.

**Negative**

- `@openhands/typescript-client` drags `@openrouter/sdk` into the dependency tree even though it is
  never imported (**V-5**). Mitigated by subpath-only imports, a lint rule and `npm audit`;
  revisited via the documented `fetch` fallback if it ever becomes a real problem.
- Pinning the client to `1.49.6` means an OpenHands upgrade requires a deliberate, tested bump —
  intentional, but it is maintenance work that will not happen by itself.
- A TypeScript build step exists, so the container image needs a build stage and `npm ci` must stay
  reproducible.
- Node's single-threaded model means a long synchronous operation would stall the poll loop. Nothing
  in the design is CPU-bound, but any future feature that is (large diff parsing, archive handling)
  must be explicitly chunked or rejected.

**Follow-up actions**

- Commit `package-lock.json` and add `npm audit --omit=dev` to CI (work package 1).
- Record the pinned client version and the `/openapi.json` deploy check in the README (work
  package 14), so the upgrade procedure is written down once.

## Security considerations

- **Supply chain is the dominant risk of this ADR.** Controls: five direct runtime dependencies, all
  MIT; a committed lockfile with exact resolution; `npm audit` in CI; an exact pin on the OpenHands
  client; `no-restricted-imports` lint rules banning `child_process` (ADR-0001) and `dist/llm/*`;
  production-only dependencies in the runtime image stage; `USER node` (non-root, FR-9). The small
  dependency count *is* the main control — there is no egress allowlist available at this tier, so
  any dependency can in principle read `process.env`.
- **Secret handling is a runtime, not a dependency, concern:** `TELEGRAM_BOT_TOKEN` and
  `OPENHANDS_API_KEY` live only in process memory, are never written to SQLite, and are redacted by a
  logger hook that replaces known secret values with `***` and allowlists loggable fields (NFR-5,
  AC-16). `OH_SECRET_KEY` is deliberately **not** passed to the Gateway at all (R1-F11).
- **Input validation:** `zod` validates configuration at boot (fail fast on a missing token, missing
  key, empty allowlist or non-numeric user IDs) and guards the shape of inbound event payloads before
  the translator reads them, so a malformed or unexpected event cannot crash the subscriber.
- TLS to `api.telegram.org` uses the library default with certificate verification on. No custom CA,
  no `NODE_TLS_REJECT_UNAUTHORIZED` override anywhere.

## Operational considerations

- **Image:** `node:22-alpine` multi-stage; expected final size ~150–200 MB, RSS ~100–150 MB. Built by
  Coolify from GitHub on push, as the stack already does.
- **Runtime config:** all via environment variables, validated at boot; `.env.example` documents every
  one with empty placeholders for the two secrets.
- **Upgrades:** Node 22 LTS until its end of life; dependency bumps are ordinary PRs, except
  `@openhands/typescript-client`, which must be bumped together with a re-run of the `/openapi.json`
  check from architecture §21.
- **Rollback:** redeploy the previous image tag; nothing in the runtime choice is stateful.
- **Debuggability:** `--enable-source-maps` so stack traces point at TypeScript lines; structured JSON
  logs with a `request_id` per inbound update.
- **Cost:** €0 in licences and services; the only cost is the container's share of existing VPS
  resources.
