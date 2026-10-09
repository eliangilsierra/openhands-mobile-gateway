# OpenHands Mobile Gateway

Telegram gateway for OpenHands agent-canvas conversations. See
[docs/architecture/1-openhands-mobile-gateway.md](docs/architecture/1-openhands-mobile-gateway.md)
for the full architecture and [docs/decisions/](docs/decisions/) for the Accepted ADRs.

## Security note: preventive mitigation of OpenHands/OpenHands #17763

`docker-compose.yml`'s `agentcanvas` service's `environment:` block sets one extra variable:

```yaml
OH_SESSION_API_KEYS_0: ${SERVICE_PASSWORD_64_CANVASKEY}
```

**Why it is there.** [ADR-0007](docs/decisions/ADR-0007-agentcanvas-auth-trust-boundary.md)
documents an upstream defect,
[OpenHands/OpenHands#17763](https://github.com/OpenHands/OpenHands/issues/17763): when
`agentcanvas`'s `session_api_keys` list is empty, its `X-Session-API-Key` check becomes a no-op and
`/api/*` accepts any request on the Docker network, regardless of the key sent. ADR-0007 §6 names
`OH_SESSION_API_KEYS_0` (same value as `LOCAL_BACKEND_API_KEY`) as the one-line fix, but marks it as
"the person's call, outside the Gateway's scope" because it is a change to `agentcanvas`, which
FR-10/AC-12 forbid the Gateway's own design from making.

The project owner reviewed this trade-off and, in the "Decision recorded" comment on
[Issue #1](https://github.com/eliangilsierra/openhands-mobile-gateway/issues/1#issuecomment-6071438525),
explicitly declined to run the ADR-0007 §5 read-only verification commands against the live VPS and
instead directed the team to "assume the #17763 defect may be live (worst case) and apply the
recommended remediation preventively, rather than leaving the risk accepted as unquantified." This
line is that preventive remediation, added as a deliberate, explicitly human-authorized **exception**
to the general "never modify `agentcanvas`" rule — scoped to exactly this one environment variable,
not a precedent for any other change to that service.

**This is not a confirmed fix.** Whether the #17763-class defect was actually live on this
deployment, and whether this line resolves it in practice, has **not been verified** against the
running VPS — the agent team has no network path to it, and the owner explicitly chose not to run
the verification commands. Treat this as a precaution applied under uncertainty, not as evidence
that a vulnerability existed or that it is now closed.

**How it takes effect.** This repository's `docker-compose.yml` is the source of truth the owner
redeploys from via Coolify. The line above only takes effect once the owner pulls and redeploys this
file on the VPS; nothing in this repository applies it automatically to the running instance.

**How to revert.** Remove the `OH_SESSION_API_KEYS_0` line from the `agentcanvas` service's
`environment:` block and redeploy. Nothing else needs to change: `agentcanvas` behaves exactly as it
did before this line was added — no image, volume, other environment variable, or Cloudflare Tunnel
configuration is affected by adding or removing it.

See also: [ADR-0007](docs/decisions/ADR-0007-agentcanvas-auth-trust-boundary.md) and the
[coordinator's decision comment on Issue #1](https://github.com/eliangilsierra/openhands-mobile-gateway/issues/1#issuecomment-6071438525).
