# ADR-0001: Build the Mobile Gateway as a thin sibling container that drives OpenHands over its HTTP/WebSocket API

## Status

Proposed

| Field | Value |
| --- | --- |
| Date proposed | 2026-10-08 |
| Date decided | — |
| Decided by | — |
| Related Issue | [#1](https://github.com/eliangilsierra/openhands-mobile-gateway/issues/1) |
| Supersedes | None |
| Related ADRs | ADR-0002 (runtime), ADR-0003 (store), ADR-0004 (Telegram transport), ADR-0005 (mapping), ADR-0006 (events), ADR-0007 (auth boundary) |

## Context

The person runs a self-hosted OpenHands Agent Canvas on an Ubuntu VPS with Coolify. The Compose
stack has two services: `agentcanvas` (`ghcr.io/openhands/agent-canvas:latest`, `expose: 8000`, no
host port mapping) and `cloudflared`. The goal (G-1) is to drive that installation from Telegram on
a phone; the explicit non-goal (G-2) is to re-implement any agent, tool, skill or Claude Code logic.

Established by research and re-verified in the architecture stage:

- The image is `OpenHands/OpenHands` at tag **v1.24.0**: one container running agent-server
  (internal `:18000`, pinned to `software-agent-sdk` **1.49.6**), the automation backend
  (`:18001`), the static frontend and a bundled VS Code (`:8001`), all behind a single Node ingress
  proxy on port 8000 (R1-F3, R1-F13). Port 8000 is the only port `expose`d; nothing is published to
  the host.
- The ingress proxy routes `/api/*`, `/sockets/*`, `/server_info`, `/health`, `/openapi.json` and
  more to the agent-server (**V-1**, read from `docker/entrypoint.sh` at v1.24.0). The internal
  ports are unreachable from any other container.
- The agent-server exposes everything the Gateway needs: conversation create/get/search, message
  send, `run`/`pause`/`interrupt`, confirmation policy and response, timestamp-filtered event
  search, and a WebSocket event stream (R2-F3…F24). All `/api/*` routes require
  `X-Session-API-Key` (R2-F17, **V-2**).
- OpenHands does **not** track "the active conversation for a project"; `StartConversationRequest`
  carries only `workspace.working_dir` (R3-F1, R3-I1). Any chat↔conversation mapping must be held
  by the caller.

Hard constraints: zero changes to the `agentcanvas` service (FR-10, AC-12); port 8000 must never be
published (NFR-1, AC-13); no new paid service, no Redis/Postgres/broker/queue/Kubernetes (NFR-2);
the mapping must survive restarts and days (FR-8, AC-9, AC-10); the OpenHands integration must not
be hard-coupled to Telegram (NFR-8).

A topology decision is needed before anything can be planned or built, and it is expensive to
reverse: it fixes the deployment unit, the trust boundaries, the dependency surface and the module
layout of the whole project.

## Decision

We will build the Mobile Gateway as **one new Docker Compose service, `mobile-gateway`, that is a
thin client of the existing `agentcanvas` HTTP and WebSocket API** (Option A in the architecture
document's comparison).

Scope of the decision:

1. **One additional container**, built from this repository, joining the **existing default Compose
   network**. No `networks:` key is added to any service, because adding one would require editing
   `agentcanvas` (forbidden by FR-10/AC-12).
2. It reaches OpenHands **only** at `http://agentcanvas:8000` (REST) and
   `ws://agentcanvas:8000/sockets/events/{conversation_id}`, always presenting
   `X-Session-API-Key`. It never targets `:18000`, `:18001` or `:8001`, and it never requires port
   8000 to be published.
3. It **publishes no port to the host**. Its `GET /health` listener is `expose`d only, so it is
   reachable from the Docker network and from the container's own healthcheck.
4. It restricts itself to the **15 calls enumerated in §21 of the architecture document** and
   nothing else. All HTTP and WebSocket access is confined to `src/openhands/*`, so the coupling to
   OpenHands' internal API lives in two files.
5. It **implements no agent logic**: no LLM call of any kind, no Anthropic/OpenRouter/other provider
   request, no `claude` or OpenHands CLI invocation, no tool/skill execution, no subprocess at all
   (lint-enforced ban on `child_process`), and no decision about which repository to use beyond
   routing to a `working_dir` the user selected.
6. **Module boundary for NFR-8:** `src/core/*` and `src/openhands/*` must not import from
   `src/channels/*` nor reference Telegram types, emoji or message formatting. A future channel adds
   `src/channels/<name>/` and nothing else. There is deliberately **no plugin system, no registry
   and no dynamic dispatch** — one factory at startup selects the enabled channel.
7. It mounts **no `agentcanvas` volume** — not `canvas-projects`, not `claude-home`. Project listing
   goes through the OpenHands API instead (ADR-0005), so the Gateway never touches the canvas's
   filesystem or Claude credentials.

## Alternatives

| Alternative | Summary | Why not chosen |
| --- | --- | --- |
| **B. Telegram → OpenHands API directly, no Gateway** | Point Telegram at the OpenHands API and let it talk to the agent-server unmediated. | Technically unsound on three counts at once. Telegram cannot attach an `X-Session-API-Key` header to a webhook POST, cannot hold a WebSocket to receive the event stream, and cannot be restricted to the owner's user ID — so FR-2, FR-6, FR-7 and NFR-3 are unimplementable. It would also require publishing port 8000 to the Internet for Telegram to reach it, directly violating NFR-1/AC-13 and massively widening the blast radius of the #17763 defect (ADR-0007). Finally, no endpoint on the agent-server accepts a Telegram `Update` payload, and nothing would hold the chat↔conversation mapping FR-8/AC-9/AC-10 require (R3-I1). Rejected. |
| **C. Gateway embeds the OpenHands SDK (`openhands-sdk`) and drives the agent in-process** | The Gateway imports the Python agent SDK rather than being an HTTP/WS client. | It pulls a **second agent runtime** into the Gateway, which is exactly the duplication G-2 forbids: the SDK exists to *run* agents (LLM clients, tool definitions, confirmation policies, condensers), not to proxy a remote one. It would mean a Python toolchain plus a large transitive dependency tree alongside, or instead of, the Node runtime (ADR-0002), two upgrade cadences that must both stay compatible with the running agent-server, and a second place where agent behaviour could diverge from what the browser UI does. It buys nothing a thin client lacks: every capability the Gateway needs is already an HTTP or WS route (R2-F3…F24), and the SDK's own socket client does not even support the replay parameter NFR-3 requires (**V-6**), so the WebSocket layer would have to be hand-written anyway. Larger memory footprint on a VPS already running Claude Code sessions. Rejected. |
| **D. Gateway as an OpenHands "automation"/extension running inside the `agentcanvas` container** | Add the Telegram poller to the canvas image or its automation backend. | Requires building a custom image or injecting code into `agentcanvas`, which is forbidden by FR-10/AC-12, and would break on every upstream image update. It would also place the Telegram bot token inside the container that holds the Claude credentials in `claude-home`, enlarging the consequences of any compromise. No supported extension point for a long-running poller was found. Rejected. |
| **E. Hosted automation platform (n8n / Make / Zapier) as the glue** | Use a SaaS workflow tool between Telegram and OpenHands. | Excluded by NFR-2 (explicitly named as out of scope), needs public exposure of the OpenHands API, and cannot hold a WebSocket for NFR-3. Rejected. |
| **F. Do nothing — use the browser UI on the phone** | Keep the current situation. | The honest baseline, recorded so the project's cost stays visible. Rejected only because G-1 is precisely about not doing that. |

## Consequences

**Positive**

- Satisfies all four hard constraints simultaneously: zero `agentcanvas` changes, no public exposure
  of port 8000, no new paid infrastructure, no duplicated agent logic.
- One deployable, one log stream, one health endpoint, one process to restart; fits the existing
  Coolify + GitHub flow with a single Compose block (FR-9, AC-11).
- Can hold durable state, which is non-negotiable for FR-8/AC-9/AC-10 and which OpenHands provably
  does not do for us (R3-I1).
- The Gateway can be stopped or removed with no trace in `agentcanvas`; failure of the Gateway never
  degrades the browser UI.
- Least privilege by discipline: a 15-call allowlist inside two modules, no volume mounts, no
  subprocess, no inbound network socket from the Internet.

**Negative**

- **A real coupling to an internal, unversioned API.** The 15 calls are not a published public
  contract. Accepted and bounded: verified against the exact pinned version, pinned through
  `@openhands/typescript-client@1.49.6` (ADR-0002), confined to `src/openhands/*`, and checked at
  deploy time against the live `/openapi.json` (architecture §21). An OpenHands upgrade can still
  break the Gateway and will require an adapter fix.
- A second always-on process to operate and keep patched.
- The Gateway inherits whatever authentication posture the running `agentcanvas` actually has; it
  cannot fix the #17763 defect without touching `agentcanvas` (see ADR-0007).
- Joining the existing default network rather than a dedicated one means the Gateway sits on the
  same network segment as everything else in the Compose project. This design adds exactly one
  container there and no new network, so it does not make the situation worse, but it does not
  improve it either (ADR-0007).

**Follow-up actions**

- The person runs the read-only verification commands in architecture §21 (V-C0…V-C8) to confirm
  the deployed agent-server is 1.49.6 and that the 15 routes exist on the running build. A mismatch
  is a `design-gap` feedback loop back to the Architect, not something a Developer should improvise.
- Record the pinned `@openhands/typescript-client` version in the README alongside the
  `/openapi.json` check, so a future upgrade has an obvious starting point.

## Security considerations

Creates two trust boundaries and no public one.

- **B1 (Internet ↔ Gateway, via the Telegram Bot API):** outbound TCP only — the Gateway never
  accepts an inbound connection from the Internet (a direct consequence of ADR-0004). The only
  authorization control in the whole system is the `TELEGRAM_ALLOWED_USER_IDS` allowlist, applied as
  the first middleware before any parsing or storage; unauthorized users get a fixed
  `⛔ Unauthorized` and create no state (FR-7, AC-2, AC-8).
- **B2 (Gateway ↔ `agentcanvas`):** plaintext HTTP by design, because it never leaves the Docker
  bridge and TLS would require changing `agentcanvas`. `X-Session-API-Key` is injected once in the
  HTTP client's default headers so no call site can omit it; the WebSocket uses first-message auth
  rather than the deprecated `?session_api_key=` query form, keeping the key out of proxy logs
  (R2-F21). The credential is all-or-nothing, which is why the 15-call allowlist exists.
- **Supply chain:** the main cost of this ADR. The Gateway takes a dependency on
  `@openhands/typescript-client`, whose own dependencies include `@openrouter/sdk` (**V-5**). The
  Gateway imports only the client subpaths and never `dist/llm/*`, so no LLM provider code executes,
  but the package is present in the tree. Mitigations: a ~5-package direct dependency budget, a
  committed lockfile, `npm audit` in CI, a pinned version, and a non-root container.
- **Not mounting `claude-home`** closes Issue risk R-5 structurally: the Gateway cannot read Claude
  credentials because they are not in its filesystem.
- **Residual, accepted:** the owner can ask the agent to do destructive things, and hostile content
  inside a repository can steer the agent (prompt injection). This is outside the Gateway's control
  by design (G-2). The Gateway's contributions are the confirmation policy that surfaces risky
  actions for an explicit Allow/Deny (ADR-0006) and the allowlist that ensures only the owner can
  prompt at all.

## Operational considerations

- **Deployment:** one Compose service with `build: .`, `restart: unless-stopped`,
  `depends_on: [agentcanvas]`, `expose: ["8080"]` and **no `ports:`**, a `gateway-state` volume, and
  a `node -e fetch(...)` healthcheck against `127.0.0.1:8080/health`. Secrets come from Coolify
  environment variables; `config.ts` validates at boot and exits non-zero on anything missing, so a
  misconfigured deploy fails visibly instead of silently accepting strangers.
- **Monitoring:** Docker healthcheck (surfaced by Coolify) plus structured JSON logs on stdout. The
  actionable log events are `openhands.auth_failed`, `health.degraded`, a Telegram 409, and repeated
  `ws.reconnect_scheduled`. No metrics or tracing backend is added, because none exists in the stack
  and no NFR asks for one.
- **Rollback:** redeploy the previous image tag. Full removal is `docker compose stop
  mobile-gateway` plus deleting the service block — `agentcanvas` never changed, so there is nothing
  to undo there.
- **Cost:** €0 incremental. One container, ~100–150 MB RSS, negligible idle CPU, one named volume.
- **Ownership:** a single owner operating a single instance. Running two instances is unsupported
  (ADR-0003, ADR-0004) and would surface as a Telegram 409.
