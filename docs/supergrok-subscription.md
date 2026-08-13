# SuperGrok/xAI connected subscriptions

This is the canonical contract for SuperGrok/xAI connected-subscription
authority, account management, allocation, leasing, and durable capacity
recovery. The xAI API-key provider remains a separate rail.

Canonical implementation sources:

- protocol/OAuth/transport: `packages/xai-subscription`;
- public management API: `apps/api/src/routes/supergrok.ts`;
- persistence and RLS: `packages/db/src/xai-subscription.ts`,
  `packages/db/src/index.ts`, `packages/db/src/schema.ts`, and migration
  `0234_xai_subscription_authority.sql`;
- runtime: `apps/worker/src/activities/xai-auth.ts` and
  `apps/worker/src/activities/agent-turn.ts`;
- workflow capacity orchestration: `apps/worker/src/activities/codex-capacity.ts`
  and `apps/worker/src/workflows/session.ts`;
- clients: the SuperGrok methods/types in `@opengeni/sdk`,
  `useSuperGrokAccounts` in `@opengeni/react`, and the workspace settings card.

## Enablement and connection

`OPENGENI_SUPERGROK_SUBSCRIPTION_ENABLED=true` enables the rail. OAuth material
is authenticated-encrypted at rest, so a stable
`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` is required before connection or runtime
materialization can succeed.

Connection uses xAI's OAuth device flow. The API returns a user code and
verification URI, polls the provider server-side, verifies the OIDC user-info
identity, and upserts the encrypted credential by provider identity. List,
status, SDK, React, and web surfaces are metadata-only; access tokens, refresh
tokens, cookies, encrypted blobs, and provider response bodies never cross them.

## Authority model

Every account has one immutable authority scope:

- **`workspace`** — the default and simplest path. The account is shared with
  members who can use that workspace's model rail. Connecting or mutating this
  scope requires workspace-admin authority.
- **`user`** — explicit private authority. Connect and mutation require the
  exact managed-browser human with `connections:write`; bearer authentication
  is rejected for this path. The row is bound to the generic
  organization-user resource authority and exact membership generation.

Connection attribution is audit metadata, not ownership authority. There is no
per-use consent flow, implicit personal-account selection, or fallback to the
session creator/current browser user/another member.

At each acceptance boundary OpenGeni freezes an identifier-free
`XaiProviderAccountAuthoritySnapshotV1` on the logical turn or scheduled task.
Workspace scope records only `{version:1, scope:"workspace"}`. User scope adds
the immutable authority generation, never a credential UUID, membership UUID,
provider subject, label, quota, plan, or token. Direct Send/Steer resolves the
authenticated subject's current active authority; edits copy the source turn;
children copy the exact spawning parent turn; goal continuations copy the latest
finished causal turn; scheduled occurrences copy the task snapshot; compaction,
agent messages, child results, and coalesced internal updates preserve the same
snapshot. Private work additionally requires the exact initiating human.

## Allocation, pins, and leases

One rotation row serializes each workspace or exact-user pool. Credentials have
separate health and allocator state: `status=active` is credential health, while
`allocator_enabled` controls only new selection. Reconnect and refresh restore
credential health but do not silently change allocator eligibility.

Selection is deterministic and transaction-scoped:

1. revalidate the accepted turn's authority snapshot under exact-subject FORCE
   RLS;
2. lock the pool rotation row, reap expired leases, and reuse an exact live
   same-turn lease when present;
3. filter to active, allocator-enabled, non-exhausted, currently unleased
   accounts; an expired access token remains eligible because the request
   transport can refresh it;
4. honor a session pin when present; otherwise use fair least-selected,
   least-recent ordering when rotation is enabled, or the explicit active
   credential when rotation is disabled;
5. write the unique `(workspace_id, turn_id)` lease, fairness metadata, and
   active cursor in one transaction.

The five-minute lease is renewed every minute and at runtime/model-usage
ownership checkpoints. A replacement holder advances generation. Every release
is idempotent and transactionally advances matching capacity waiters plus the
workflow-wake outbox so newly freed capacity is not stranded.

## Provider requests and media

The worker decrypts only the exact selected credential after revalidating the
frozen authority. Requests use request-local async context; credentials never
enter session history, events, RunState, model-visible tool arguments, or the
sandbox environment. A 401 receives one OAuth refresh and one replay of the
same replayable JSON request. The Responses transport normalizes xAI's stream,
encrypted reasoning, hosted web/X search, and live model metadata. Portable
compaction reuses the same provider context. Image generation uses the ordinary
durable generated-image operation/artifact boundary; xAI video helpers retain
their existing durable video boundary.

## Failure and durable capacity semantics

Only definitive account refusal may walk the pool:

- a typed permanent refresh failure or marked 401 sets the exact leased
  credential to `needs_relogin`;
- a marked 403 sets that credential to `error`;
- a marked 429 installs an exact-account cooldown using `Retry-After`, falling
  back to one minute.

The credential mutation, exact lease fence, exact attempt close, pending-tool
closure, audit events, turn/session `waiting_capacity` transition, lease
release, and waiter arm are one transaction. Conversation truth is checkpointed
first. The worker immediately performs one metadata-only re-evaluation: an
alternate account moves the same logical turn to `recovering`; otherwise the
provider-tagged waiter persists until a quota reset, account reconnect,
allocator/rotation/pin mutation, lease release, or bounded timer wakes it.

Ambiguous network failures, provider 5xx, malformed/partial streams, invalid
content, and unrelated 4xx errors do not quarantine or rotate credentials. They
remain on the existing same-provider recovery or terminal path because upstream
acceptance/effects may be ambiguous.

The waiter stores no credential material. It carries the blocked turn
generation, pool scope, optional active-goal id/version fence, reset/check time,
and revisioned wake state. PostgreSQL is authoritative; Temporal signals are
repairable hints, and `session_workflow_wake_outbox` repairs commit-to-signal
loss. Pause preserves the waiter. Steer, cancellation, goal change, authority
change, active-turn change, or another semantic fence supersedes it cleanly.
The protocol never creates a queue row, synthetic user message, model polling
turn, consent prompt, or ambient-user fallback.

## Public management surface

The workspace-scoped REST surface supports device-flow start/poll, metadata
list/status, active-account selection, rotation enablement, allocator OCC,
rename, and disconnect. `@opengeni/sdk` exposes matching typed methods;
`@opengeni/react` exposes `useSuperGrokAccounts`; the OpenGeni web workspace
settings page provides the complete account controls. Workspace is the default
scope in every client. Private scope must be selected explicitly and succeeds
only through the managed-browser human boundary above.