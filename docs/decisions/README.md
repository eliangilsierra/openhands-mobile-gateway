# Architecture Decision Records

An **Architecture Decision Record (ADR)** captures one significant decision, its context, the
alternatives considered and its consequences. ADRs are the memory of *why* this system is shaped
the way it is.

## Index

| ADR | Title | Status | Date proposed |
| --- | --- | --- | --- |
| [ADR-0001](ADR-0001-thin-sibling-gateway-over-openhands-http-api.md) | Build the Mobile Gateway as a thin sibling container that drives OpenHands over its HTTP/WebSocket API | Accepted | 2026-10-08 |
| [ADR-0002](ADR-0002-typescript-node-runtime.md) | Implement the Gateway in TypeScript on Node.js, with grammY and the official OpenHands TypeScript client | Accepted | 2026-10-08 |
| [ADR-0003](ADR-0003-sqlite-for-gateway-state.md) | Persist all Gateway state in a single SQLite file on a Docker volume | Accepted | 2026-10-08 |
| [ADR-0004](ADR-0004-telegram-long-polling.md) | Receive Telegram updates by long polling, not by webhook | Accepted | 2026-10-08 |
| [ADR-0005](ADR-0005-project-conversation-mapping.md) | Own the project registry in the Gateway and bind one active conversation per (chat, project) | Accepted | 2026-10-08 |
| [ADR-0006](ADR-0006-event-stream-and-recovery.md) | Consume OpenHands events over the agent-server WebSocket with timestamp replay and client-side deduplication by event id | Accepted | 2026-10-08 |
| [ADR-0007](ADR-0007-agentcanvas-auth-trust-boundary.md) | Always send `X-Session-API-Key` while treating the `agentcanvas` API as an unverified-auth boundary, and accept the #17763 risk | Accepted | 2026-10-08 |

Keep this index updated in the same Pull Request that adds or changes an ADR.

All seven ADRs above belong to the design in
[`docs/architecture/1-openhands-mobile-gateway.md`](../architecture/1-openhands-mobile-gateway.md)
and are each decidable on their own.

## Lifecycle

| Status | Meaning | Who sets it |
| --- | --- | --- |
| `Proposed` | Written and under discussion. **Planning and implementation must not depend on it.** | Author (Architect agent or human) |
| `Accepted` | In force. All work must comply. | **A human**, through an approving review on the ADR's Pull Request |
| `Rejected` | Considered and not adopted. Kept for the record. | A human |
| `Deprecated` | No longer relevant; not replaced. | A human |
| `Superseded by ADR-NNNN` | Replaced by a newer ADR. | A human, in the Pull Request that accepts the new ADR |

Rules:

- Agents may write `Proposed` ADRs; **only a human changes an ADR's status.**
- After acceptance, the Context, Decision and Alternatives sections are immutable. Typos may be
  fixed; meaning may not change.
- To change an Accepted decision, write a new ADR with its `Supersedes` field set, and in the same
  Pull Request change the old ADR's status line to `Superseded by [ADR-NNNN](...)`.

## Naming

```text
docs/decisions/ADR-NNNN-kebab-case-title.md
```

`NNNN` is zero-padded and monotonically increasing; numbers are never reused, even for rejected
ADRs. The title is short, imperative, and names the decision rather than the problem.

## When an ADR is required

When a decision is significant and **expensive to reverse**: choosing or replacing a framework,
language, data store or major library; defining or changing an API contract, event schema or shared
data model; creating, moving or removing a trust boundary, or changing the authentication or
authorization model; introducing new infrastructure, a hosted service or a vendor; changing
deployment topology or the release process; or deliberately deviating from an existing ADR.

An ADR is not required for decisions that are local, cheap to reverse and covered by existing
conventions. When in doubt, write a short ADR.
