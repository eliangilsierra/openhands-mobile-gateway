# ADR-0004: Receive Telegram updates by long polling, not by webhook

## Status

Proposed

| Field | Value |
| --- | --- |
| Date proposed | 2026-10-08 |
| Date decided | — |
| Decided by | — |
| Related Issue | [#1](https://github.com/eliangilsierra/openhands-mobile-gateway/issues/1) |
| Supersedes | None |
| Related ADRs | ADR-0001 (topology), ADR-0002 (grammY), ADR-0003 (single instance) |

## Context

Q-7 in Issue #1 is an explicit open question for the Architect: webhook or long polling, *in this
specific Coolify + Cloudflare Tunnel deployment*. NFR-10 leaves it open. FR-1/AC-1 require the first
response to reach Telegram within 2 seconds. The brief asks that existing infrastructure — in
particular the Cloudflare Tunnel — not be touched more than strictly necessary (FR-10's spirit), and
NFR-1 forbids new public exposure of the OpenHands API.

Research established (comment 6048825184):

- `getUpdates` accepts `offset`, `timeout` and `limit` (1–100) (R3-F7).
- `setWebhook` requires an **HTTPS** URL on one of exactly four ports (443, 80, 88, 8443); plain HTTP
  is impossible; TLS 1.2+ is required; CA-signed certificates must match the webhook hostname and
  supply the full chain, or a self-signed public certificate must be uploaded; the host must accept
  inbound POSTs from Telegram's subnets `149.154.160.0/20` and `91.108.4.0/22`; **IPv6 is not
  supported** for webhooks (R3-F8, R3-F9).
- A single `cloudflared` tunnel can route multiple public hostnames, so a webhook would need **one
  new DNS record plus one new ingress rule** on the person's existing tunnel — no second tunnel, but
  real new public surface that does not exist today (R3-F14, R3-I4).
- Whether Cloudflare's edge certificate satisfies Telegram without any certificate work was recorded
  as an **assumption**, not verified (R3-A1).
- All three mainstream Node libraries support both modes; library maturity is not a differentiator
  (R3-F11, R3-F12, R3-F13, R3-I3). grammY's maintainers state there are "no major drawbacks" to long
  polling absent a specific reason for webhooks (R3-F11), and that polling lets the bot run "without
  exposing a public URL".
- Telegram's outbound rate limits (≈1 message/second per chat) apply identically in both modes
  (R3-F10), so they do not discriminate between them.

Verified in this stage (**V-7**): `getUpdates`' `timeout` parameter makes it a *long* poll — the
request is held open and returns as soon as an update is available. The research's comparison table
framed polling latency pessimistically as "bounded by the poll interval"; that is wrong for long
polling. Inbound latency is a network round trip, typically well under a second, which is what makes
FR-1's 2 s budget comfortably reachable without a webhook.

The decision is moderately hard to reverse — it determines whether the Gateway has an inbound HTTP
listener exposed to the Internet, which changes the trust model, the Compose file, the DNS records
and the tunnel configuration.

## Decision

We will **confirm research recommendation R-2**: the Gateway receives Telegram updates by **long
polling `getUpdates`**, and **no webhook is configured**.

Specifics:

1. grammY's default long-polling runner with `timeout=30`, `limit=100`, `offset=<last+1>`, and
   `allowed_updates: ["message", "callback_query"]` — the only two update types the design handles.
2. **No inbound listener is exposed to the Internet.** The Gateway's only HTTP server is `GET /health`
   on an `expose`d-but-unpublished port (NFR-4). The Cloudflare Tunnel configuration and its DNS
   records are **not touched at all**.
3. `offset` advances only after an update has been fully handled or durably recorded. Telegram's
   delivery is at-least-once, so a duplicate `update_id` is treated as a no-op, and the actions an
   update triggers are either idempotent or visible to the user.
4. **Error handling** (architecture §7.1 and §10): HTTP 409 (another poller running, or a webhook is
   set) → log `ERROR`, set `/health` to `degraded`, keep retrying, and **never** call `deleteWebhook`
   automatically — a 409 usually means a second instance is running, and silently stealing the
   update stream would hide that. 429 → honour `retry_after`. Network errors → exponential backoff
   with full jitter, 1 s base, 60 s cap, unlimited attempts. Telegram being unreachable is **not** a
   fatal health condition (NFR-4): `/health` reports `telegram: disconnected` while `status` stays
   `ok`.
5. **Exactly one Gateway instance** may run. This is already required by ADR-0003's single-writer
   SQLite model, so polling adds no new operational constraint.
6. **This is not a one-way door.** The Telegram transport lives behind `src/channels/telegram/`
   (ADR-0001's module boundary) and grammY ships a `webhookCallback()` adapter (R3-F12). Switching
   later means adding an HTTP route, one DNS record and one tunnel ingress rule — and would need its
   own ADR because it creates a new public trust boundary.

## Alternatives

| Alternative | Summary | Why not chosen |
| --- | --- | --- |
| **Webhook via a new hostname on the existing Cloudflare Tunnel** | Add a DNS record and an ingress rule pointing a new public hostname at `mobile-gateway:8080`; call `setWebhook` with a secret token. | Technically viable (R3-F14, R3-I4) and the only option with genuinely push-instant delivery. Rejected because it **buys nothing this system needs and costs real security surface**: (a) FR-1's 2 s budget is already met by long polling (**V-7**), so the latency advantage is unused; (b) it creates the project's first inbound Internet-facing endpoint, which must then be hardened with a secret path, `secret_token` validation and ideally Telegram IP-range filtering — new controls to get right and keep right; (c) it requires changing the Cloudflare Tunnel, which the brief asks to avoid; (d) the claim that Cloudflare's edge certificate satisfies Telegram's TLS requirements without any certificate work is an unverified assumption (R3-A1), so the "it's easy" case is not actually established; (e) a webhook handler must complete within ~10 s or Telegram resends (R3-F12), which pushes work into a background queue that polling does not need. Kept as the documented upgrade path. |
| **Webhook on a second Cloudflare Tunnel or a directly published port** | Dedicated tunnel or `ports: 8443:8443` on the Gateway. | Strictly worse than the option above: more infrastructure for the same benefit, and publishing a port to the host contradicts the design's "no host port" posture and sits uncomfortably beside NFR-1's intent. Rejected. |
| **Short polling (`getUpdates` with `timeout=0`) on a timer** | Poll every few seconds. | This is the option whose latency really *is* bounded by the interval, and it wastes requests while idle. Strictly dominated by long polling. Rejected. |
| **A third-party relay (e.g. a serverless function forwarding to the VPS)** | Receive the webhook off-site and forward it. | Adds a paid/third-party component (NFR-2), a second place holding the bot token, and still needs an inbound path to the VPS. Rejected. |

## Consequences

**Positive**

- **Zero new public attack surface.** The Gateway never accepts an inbound connection from the
  Internet; boundary B1 is outbound-only. This is the single largest security benefit in the whole
  design and the reason the system has no public trust boundary at all.
- **Zero changes to the Cloudflare Tunnel, DNS, or any certificate.** Nothing outside the new
  Compose service is modified, which keeps FR-10/AC-12 trivially satisfied.
- Works unchanged if the person's public hostname, tunnel or DNS ever changes, and works from behind
  NAT or a restrictive firewall.
- No webhook timeout to design around: an update can take as long as it needs, so there is no need
  for a background queue or worker (which NFR-2 forbids anyway).
- Simplest possible failure mode: if the poll fails, the Gateway retries; Telegram retains updates
  for roughly 24 hours, so a short outage loses nothing.

**Negative**

- One persistent outbound HTTPS connection to `api.telegram.org` is always open, and the Gateway
  must be running to receive anything — there is no queue absorbing updates on the VPS side (though
  Telegram's own retention covers this).
- Latency is a round trip rather than a push; measured in hundreds of milliseconds, inside FR-1's
  budget, but not sub-100 ms.
- **Only one instance may poll.** A second instance causes a 409 and a fight over the update stream.
  Accepted — ADR-0003 already imposes this.
- If the person ever sets a webhook manually for testing, polling will 409 until it is removed; the
  Gateway reports this loudly instead of fixing it silently.

**Follow-up actions**

- Work package 5 implements the poller, the 409/429/backoff handling and the allowlist middleware.
- Work package 14 documents in the README that exactly one instance may run, and that a manually set
  webhook must be deleted before polling works.

## Security considerations

This is primarily a **security** decision, not a latency one.

- **Trust boundary B1 becomes outbound-only.** There is no listening socket for an attacker to find,
  scan, fuzz or flood; no TLS termination to configure; no webhook secret to rotate; no public
  hostname tied to the Gateway. Threat T-B1-4 (DoS/flooding) is largely structural rather than
  mitigated: there is nothing to flood.
- **Authentication vs authorization:** the bot token authenticates the *Gateway to Telegram*. It does
  **not** authenticate incoming updates — any Telegram user who finds the bot can message it, and the
  bot's username is effectively public. The only authorization control in the system is the
  `TELEGRAM_ALLOWED_USER_IDS` allowlist, applied as the **first** middleware before any parsing,
  storage or OpenHands call, replying with a fixed `⛔ Unauthorized` and creating no state (FR-7,
  AC-2, AC-8; threats T-B1-1, T-B1-2). Choosing polling does not weaken this, because a webhook's
  `secret_token` would only authenticate *Telegram as the caller*, never the end user — the allowlist
  would still be the real control either way.
- **Secret exposure:** the bot token appears in the outbound request URL path to `api.telegram.org`
  over TLS, which is the Bot API's design. It is never logged (NFR-5 redaction) and never stored
  (ADR-0003). With a webhook, the token would additionally be the subject of `setWebhook` calls and
  the secret path, giving it more places to leak.
- **Avoided risk:** had we chosen a webhook, forged inbound POSTs, replayed updates, request smuggling
  through the tunnel, and certificate/chain misconfiguration would all have become live concerns
  requiring controls. None of them exist under this decision.
- **Residual:** compromise of the VPS or of a dependency (ADR-0002's supply-chain risk) still exposes
  the token; polling does not help there.

## Operational considerations

- **Configuration:** `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS` from the environment,
  validated at boot — an empty or unparseable allowlist makes the Gateway **refuse to start**, so a
  misconfiguration cannot result in an open bot.
- **No DNS, tunnel, certificate or firewall change** is needed to deploy, redeploy or move the
  service.
- **Monitoring:** `telegram: connected|disconnected` in `/health` (informational only — never
  `degraded`, per NFR-4); log events `telegram.poll.started`, `telegram.update.received`,
  `telegram.update.rejected`, `telegram.send`, `telegram.send_failed`. The signal worth watching is a
  persistent 409, which means a second instance or a stale webhook.
- **Outbound requirement:** the VPS must be able to reach `api.telegram.org` on 443. If the person's
  network ever blocks it, the fallback is the webhook path above — another reason to keep the
  transport behind its own module.
- **Rate limits:** ≈1 message/second per chat and ≈30/second overall (R3-F10) govern *outbound* sends
  in either mode; the per-chat send queue and coalescing in architecture §7.6 exist for that reason,
  independently of this ADR.
- **Cost:** €0; no new DNS record, no new tunnel route, no certificate.
