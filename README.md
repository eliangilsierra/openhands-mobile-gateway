# OpenHands Mobile Gateway

Telegram gateway for OpenHands agent-canvas conversations. See
[docs/architecture/1-openhands-mobile-gateway.md](docs/architecture/1-openhands-mobile-gateway.md)
for the full architecture and [docs/decisions/](docs/decisions/) for the Accepted ADRs.

## Security note: preventive mitigation of OpenHands/OpenHands #17763

The `agentcanvas` service's `environment:` list in `docker-compose.yml` has one extra entry:

```yaml
- OH_SESSION_API_KEYS_0=${SERVICE_PASSWORD_64_CANVASKEY}
```

**Why it is there.** [ADR-0007](docs/decisions/ADR-0007-agentcanvas-auth-trust-boundary.md)
describes an upstream defect,
[OpenHands/OpenHands#17763](https://github.com/OpenHands/OpenHands/issues/17763). If it affects this
deployment, then when `agentcanvas`'s `session_api_keys` list is empty, its `X-Session-API-Key`
check may become a no-op and `/api/*` may accept requests on the Docker network regardless of the
key sent. Whether this deployment is affected has not been established. ADR-0007 section 6 names
`OH_SESSION_API_KEYS_0` as a possible remediation, but leaves it to the owner because it changes
`agentcanvas`, which FR-10/AC-12 keep out of the Gateway's design.

The project owner recorded the decision in a
[comment on Issue #1](https://github.com/eliangilsierra/openhands-mobile-gateway/issues/1#issuecomment-6071438525):
not to run the ADR-0007 section 5 read-only verification commands against the live VPS, and to
assume the defect may be live and apply a mitigation preventively. This entry is that mitigation. It
is an explicit, owner-authorized exception to the rule of not modifying `agentcanvas`, limited to
this one environment variable and not a precedent for other changes to that service.

**Status: preventive mitigation, not a fix.** Nothing was verified against the running VPS (the
agent team has no network path to it), so there is no evidence that the defect exists here or that
this entry resolves it. Do not describe the issue as fixed or closed.

**Same key as the Gateway.** `OH_SESSION_API_KEYS_0` and `LOCAL_BACKEND_API_KEY` both reference
`${SERVICE_PASSWORD_64_CANVASKEY}` in this file, so they resolve to the same value. That holds only
while both lines keep using that variable. The owner should confirm in Coolify that this variable
resolves to a single value for the service, and that the Gateway's `OPENHANDS_API_KEY` uses it too.

**When it takes effect.** This file is what the owner redeploys from via Coolify. The entry has no
effect until the owner pulls it and redeploys the stack in Coolify; nothing here changes the running
instance automatically.

**Possible client impact.** After the redeploy, any client that sends no key or a wrong
`X-Session-API-Key` may start getting 401 from `agentcanvas`. The Gateway sends the key on every
request.

**How to revert.** Remove the `OH_SESSION_API_KEYS_0` entry from the `agentcanvas` service's
`environment:` list and redeploy. No image, volume, other variable or Cloudflare Tunnel setting is
affected.

See also: [ADR-0007](docs/decisions/ADR-0007-agentcanvas-auth-trust-boundary.md).
