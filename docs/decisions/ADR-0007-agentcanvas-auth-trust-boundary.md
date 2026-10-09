# ADR-0007: Always send `X-Session-API-Key` while treating the `agentcanvas` API as an unverified-auth boundary, and accept the #17763 risk

## Status

Accepted

| Field | Value |
| --- | --- |
| Date proposed | 2026-10-08 |
| Date decided | 2026-10-08 |
| Decided by | @eliangilsierra (owner, via PR #2) |
| Related Issue | [#1](https://github.com/eliangilsierra/openhands-mobile-gateway/issues/1) |
| Supersedes | None |
| Related ADRs | ADR-0001 (topology and boundary B2), ADR-0004 (no public surface), ADR-0006 (WebSocket auth) |

## Context

The Gateway's only outbound trust boundary (B2) is `Gateway → agentcanvas`. Research found a defect
in how that boundary's authentication is wired in the deployed version, and it must be decided
explicitly rather than assumed away.

**The defect.** Two independent facts combine:

1. `openhands-agent-server` 1.49.6's `dependencies.py` implements the check as (**V-3**, exact
   source line 36):

   ```python
   if config.session_api_keys and session_api_key not in config.session_api_keys:
       raise HTTPException(status_code=401, ...)
   ```

   An **empty** `session_api_keys` list makes the check a no-op — every `/api/*` request is accepted.

2. `docker/entrypoint.sh` at `OpenHands/OpenHands` v1.24.0 only exports `OH_SESSION_API_KEYS_0` —
   the variable the agent-server actually reads — inside a branch that fires when **both**
   `LOCAL_BACKEND_API_KEY` and `OH_SESSION_API_KEYS_0` start empty (the auto-generate case) (R1-F8).
   The person's Compose file sets `LOCAL_BACKEND_API_KEY` explicitly
   (`${SERVICE_PASSWORD_64_CANVASKEY}`), so that branch is skipped and the key may never reach the
   agent-server process.

Upstream bug [OpenHands/OpenHands#17763](https://github.com/OpenHands/OpenHands/issues/17763)
describes the same root cause and states the impact as *"when `config.session_api_keys` is empty, the
authentication check passes unconditionally"*. Reported open as of 2026-10-07.

**Net effect:** the deployed agent-server's `/api/*` may accept requests with a **missing or wrong**
`X-Session-API-Key`. This is a defect in `agentcanvas`, not in the Gateway, and the Gateway cannot
fix it without modifying `agentcanvas` — forbidden by FR-10/AC-12.

**Current blast radius.** Port 8000 is `expose`d and has **no `ports:` mapping** (R1-F3, R1-F10), so
it is not reachable from the host or the Internet — only from other containers on the same Compose
network. The exposure is "anything else on that Docker network", not "the public Internet". Note also
that `command: ["--public"]` in the Compose file is a **no-op** for this image (R1-F5, R1-F7, R1-I1):
it provides none of the defense-in-depth the person may believe it does.

**Aggravating context.** The same effective session key is also defaulted into
`OPENHANDS_AUTOMATION_API_KEY`, `AUTOMATION_LOCAL_API_KEY`, `AUTOMATION_AGENT_SERVER_API_KEY` and
`AUTOMATION_KV_SECRET` (R1-F12) — one credential secures the whole canvas stack. And the credential
is all-or-nothing: there is no scoped token, so whoever can call `/api/*` can do anything the browser
UI can, in a container that also holds the Claude credentials in `claude-home`.

**Not reproducible from the agent sandbox:** there is no network path to the person's VPS, and
`:latest` may have moved since v1.24.0 was published. The runtime state of the defect is therefore
unknown and must be measured on the instance.

## Decision

We will **design the Gateway to be correct regardless of whether the defect is live, keep the
Gateway from widening the exposure, and record the residual risk as explicitly accepted pending the
person's verification.** Concretely:

1. **Always send the credential.** `X-Session-API-Key: ${OPENHANDS_API_KEY}` is set once as a default
   header in the single HTTP client inside `src/openhands/rest.ts`, so no call site can omit it; the
   WebSocket always performs the first-message auth handshake (ADR-0006). The Gateway's behaviour is
   therefore identical before and after the bug is fixed upstream, and it never relies on the bypass.
   `config.ts` **refuses to start** if `OPENHANDS_API_KEY` is empty — a missing key must not silently
   "work" because of the defect.
2. **Do not widen the exposure.** The Gateway adds **exactly one** container to the Compose network
   and **no new network**. It publishes **no host port** (its `/health` listener is `expose`d only).
   It does **not** proxy, forward or relay OpenHands' API to anything: there is no inbound Internet
   listener at all (ADR-0004), so no path exists from the Internet to `agentcanvas:8000` through the
   Gateway. It restricts itself to the 15 calls in architecture §21 and mounts no `agentcanvas`
   volume.
3. **Do not add a dedicated Docker network.** The obvious hardening — put `agentcanvas` and
   `mobile-gateway` on a private network together — requires adding a `networks:` key to the
   `agentcanvas` service, which **violates FR-10/AC-12**. This ADR records that the hardening was
   considered and rejected on that constraint, so the choice is visible rather than overlooked.
4. **Detect, do not assume.** The Gateway's `/health` reports an authenticated probe result
   (`details.api_key: accepted | rejected | unknown`) separately from the unauthenticated liveness
   probe, so "up but my key is rejected" is distinguishable from "down" (architecture §7.7).
   `openhands.auth_failed` is a first-class log event.
5. **Accept the residual risk, with a named verification step.** The person runs the two read-only
   commands below. Until they are run, the risk is **accepted as unquantified**; after they are run
   it is either closed or becomes a known, quantified condition.

   ```bash
   # Expect HTTP 401. A 200 means X-Session-API-Key is NOT being enforced.
   docker exec agentcanvas curl -sS -o /dev/null -w 'no-header -> %{http_code}\n' \
     http://127.0.0.1:8000/api/conversations/count

   # Expect HTTP 401.
   docker exec agentcanvas curl -sS -o /dev/null -w 'wrong-key -> %{http_code}\n' \
     -H 'X-Session-API-Key: definitely-not-the-key' \
     http://127.0.0.1:8000/api/conversations/count
   ```

   (Full command set, including the image-version check and the `/openapi.json` diff, in
   architecture §21.)
6. **Recommended remediation, which is the person's call and outside the Gateway's scope.** If the
   commands above return `200`, the minimal fix follows directly from V-3 and R1-F8: add
   `OH_SESSION_API_KEYS_0` to the **`agentcanvas`** service's environment, set to the same value as
   `LOCAL_BACKEND_API_KEY`. That populates `config.session_api_keys`, which makes the check enforce
   rather than pass. This is a **one-line environment addition to `agentcanvas`**, so it is formally a
   change to that service and therefore **explicitly excluded from the Gateway's own scope by
   FR-10/AC-12** — the architecture does not require it and does not depend on it either way. It is
   presented here as a recommendation for the human to accept or decline, with full visibility of the
   trade-off.
7. **Watch upstream.** Issue #17763 should be re-checked when `agentcanvas` is next updated, and the
   verification commands re-run after any image pull, since `:latest` moves.

## Alternatives

| Alternative | Summary | Why not chosen |
| --- | --- | --- |
| **Put `agentcanvas` and `mobile-gateway` on a dedicated private Docker network** | Isolate the pair so no other container can reach `:8000`. | The best technical mitigation available, and genuinely tempting. Rejected because it requires adding a `networks:` key to the `agentcanvas` service definition, which **FR-10 and AC-12 forbid** ("no environment variables or code modify agentcanvas' Docker Compose configuration"). Recorded here so the human can override the constraint if they judge the isolation more valuable than the constraint — that would be a change to this ADR and to FR-10, not something an agent should decide. |
| **Set `OH_SESSION_API_KEYS_0` on `agentcanvas` as part of this design** | Fix the defect directly in the Compose file. | The correct *fix*, and it is recommended in decision §6 — but it is a change to `agentcanvas`, so it cannot be *part of the Gateway's architecture* without violating FR-10/AC-12. Kept as a human-gated recommendation rather than a design element, so that the Gateway works identically whether or not the person applies it. |
| **Have the Gateway mediate all OpenHands access and present itself as the only client** | Treat the Gateway as a security proxy in front of the API. | Rejected: it does not help. The defect is that *other containers* can bypass auth by talking to `agentcanvas` directly; nothing the Gateway does prevents that, since it is not in the path. Worse, building a proxy would invite exposing it, which is exactly the opposite of NFR-1. |
| **Upgrade or pin `agentcanvas` to a build where #17763 is fixed** | Change the image tag. | Out of the Gateway's scope (a change to `agentcanvas`), the fix status is unknown (#17763 was reported open), and an unplanned canvas upgrade carries its own risk of breaking the 15 API calls this design depends on. Recorded as a follow-up to watch, not a decision to take now. |
| **Verify the defect from this stage and decide based on the result** | Measure first, then decide. | Not possible: the agent sandbox has no network path to the person's VPS, and the defect's presence depends on the exact `:latest` build the person pulled. Substituting a guess for a measurement would be worse than naming the unknown. Hence decision §5's explicit "accepted as unquantified until verified". |
| **Treat it as not our problem and say nothing** | The Gateway sends the header correctly; the defect is upstream. | Rejected on principle. The person is making a security-relevant decision about their own VPS, and a defect that may make their agent API unauthenticated on a shared Docker network is exactly the kind of thing an architecture document exists to surface. Silence here would be the real failure. |

## Consequences

**Positive**

- The Gateway is **correct under both conditions**: it works if the key is enforced, and it does not
  depend on the bypass if it is not. No rework is needed when upstream fixes the bug.
- The design provably does not make the situation worse: one more container, no new network, no host
  port, no inbound Internet listener, no proxying of the OpenHands API, no new volume mounts.
- The person gets a specific, read-only, two-command test and a specific one-line remediation, rather
  than a vague warning.
- `/health`'s separate `api_key` field means a key problem is visible rather than masked by a
  permissive server.
- The decision is documented and attributable, so a future reader understands why the Gateway sends a
  header that may currently be ignored.

**Negative**

- **The residual risk is accepted, not eliminated.** If the defect is live and the person declines the
  remediation, any container on that Compose network can drive the agent — which runs with the Claude
  credentials and write access to `/projects`. The Gateway cannot close this within its constraints.
- The blast radius assessment ("only containers on this network") depends on port 8000 remaining
  unpublished. If anyone ever adds a `ports:` mapping or a tunnel route to `:8000/api`, the exposure
  becomes Internet-wide. This should be stated in the README as a standing warning.
- `command: ["--public"]` remaining in the Compose file is misleading — it looks like a security
  control and is not (R1-I1). The Gateway cannot remove it (FR-10); the README should note it.
- Rejecting the dedicated-network hardening on a documentation constraint will look odd to a security
  reviewer unless the reasoning is read. That is why it is written down here explicitly.

**Follow-up actions**

- **Human:** run the two commands in decision §5 (and ideally V-C0…V-C5 from architecture §21), then
  decide on the §6 remediation. This is the one action that converts an unquantified risk into a known
  state.
- **Human:** re-run them after any `agentcanvas` image pull, because `:latest` moves.
- **Developer:** implement the single-client default header, the boot-time refusal on an empty key,
  the `details.api_key` probe, and the `openhands.auth_failed` log event (work packages 3 and 4).
- **Developer:** README section stating (a) port 8000 must never be published, (b) `--public` is a
  no-op, (c) the verification commands, (d) the optional `OH_SESSION_API_KEYS_0` remediation
  (work package 14).
- **Watch** [OpenHands/OpenHands#17763](https://github.com/OpenHands/OpenHands/issues/17763) and
  revisit this ADR when it closes.

## Security considerations

This ADR *is* a security decision; the points below are the ones not already in the Decision section.

- **Threat T-B2-1 (spoofing / elevation on the Docker network).** A malicious or compromised
  container on the same Compose network calls `agentcanvas:8000/api/*` without a key and gains full
  agent capability. Likelihood today is low (the network holds `agentcanvas`, `cloudflared`, and now
  `mobile-gateway` — all operator-controlled); impact is high (arbitrary code execution in the agent's
  workspace, access to `/projects`, and use of the Claude subscription). Mitigations in force: no
  untrusted container is added, the Gateway publishes no port, and the recommended remediation is
  documented. **Accepted with verification required.**
- **Credential hygiene at this boundary (threat T-B2-2):** the key is sent as a header, never as a
  query parameter; the WebSocket uses first-message auth specifically so it cannot land in proxy logs
  (ADR-0006); the logger redacts known secret values and allowlists loggable fields (NFR-5, AC-16);
  the key is never written to SQLite (ADR-0003). `OH_SECRET_KEY` is deliberately **not** given to the
  Gateway — it only encrypts canvas settings at rest (R1-F11) and would be a pointless additional
  secret to hold.
- **Least privilege by discipline, since none is available by mechanism:** the credential is
  all-or-nothing, so the Gateway self-limits to 15 calls routed through one module, explicitly not
  calling `/api/automation/*`, `/api/settings/*`, `/api/secrets`, `/api/bash/*`, `/api/tool/*`,
  `/api/git/*`, `/api/file/upload`, `/api/file/download`, `DELETE /api/conversations/{id}`, `/fork` or
  `/navigate` (architecture §21). This limits the damage a Gateway bug or a compromised dependency can
  do, even though it does not limit what the credential *could* do.
- **Supply-chain interaction:** ADR-0002's dependency risk is sharpened by this boundary — a malicious
  dependency in the Gateway could read `OPENHANDS_API_KEY` from `process.env` and use the full API.
  Controls are the small dependency count, the lockfile, `npm audit`, and the non-root container.
- **No new trust boundary is created by this ADR;** it characterises an existing one accurately and
  decides how to behave given a defect in it.

## Operational considerations

- **Verification is an operational task with an owner and a trigger:** the person, at first deploy and
  after every `agentcanvas` image pull. Without it, the risk stays unquantified. The commands are
  read-only and safe on a live instance.
- **Configuration:** `OPENHANDS_API_KEY` must equal `agentcanvas`'s `LOCAL_BACKEND_API_KEY`
  (`${SERVICE_PASSWORD_64_CANVASKEY}`); `.env.example` says so explicitly, and a mismatch surfaces as
  `details.api_key: rejected` in `/health` plus `openhands.auth_failed` in the logs — *unless* the
  defect is live, in which case a wrong key silently works. That asymmetry is itself a reason to run
  the verification.
- **Monitoring:** `openhands.auth_failed` and `health.degraded` are the two log events worth watching
  here. `GET /health` is the manual check.
- **Key rotation:** rotating `LOCAL_BACKEND_API_KEY` requires updating `OPENHANDS_API_KEY` on the
  Gateway and restarting both services. The Gateway holds no cached credential and no derived secret,
  so rotation is a restart, not a migration.
- **If the remediation in §6 is applied:** it is additive to `agentcanvas`'s environment and reversible
  by removing the variable; it does not touch volumes, the image or Claude auth state. The browser UI
  continues to work because the static server injects the same key into the served HTML (R1-F7).
- **Cost:** €0.
