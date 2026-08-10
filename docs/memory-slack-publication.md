# Durable workspace decision publication to Slack

OpenGeni can publish bounded summaries of important Workspace Memory changes
and completed governed-learning outcomes to one verified workspace Slack bot
channel. Slack is a notification surface only. Workspace Memory, the durable
learning attempt/receipt ledger, and their authoritative application views
remain the source of truth.

## Authority and eligibility

The original pure evaluator remains the security boundary for Workspace Memory
in `packages/core/src/domain/memory-slack-publication.ts`. It requires exact
account/workspace equality, `scopeType=workspace`, workspace audience, an active
or approved decision, valid correction/supersession lineage, a live validity
window, and a non-Slack-derived origin. It never accepts raw Memory text,
Documents, scoped-knowledge claims, collection content, prompts, logs, or
connector payloads.

The governed-learning adapter in
`packages/core/src/domain/durable-learning-slack-publication.ts` is a narrow
post-persistence consumer. The canonical router still owns learning policy,
scope resolution, authority, routing, rollback, and its immutable attempt and
receipt. The adapter verifies matching attempt id/input hash, accepts only an
exact workspace scope, requires a bounded subject summary for writes, and fails
closed for connector evidence because the v1 contract cannot prove that the
connector was not Slack. It never publishes from an authority-adapter callback
or router claim table.

## Immutable configuration

Workspace administrators configure the feature on the Capabilities page:

- choose an active, verified OpenGeni workspace-bot installation;
- choose an active bot-member channel;
- shared/Slack Connect and archived channels are excluded;
- choose `automatic`, `review`, or `quiet` independently for major, normal, and
  minor importance;
- enable or disable publication.

Every save appends an immutable configuration revision. It contains Slack team,
channel, and connection identifiers, but no bot credential. Enabling requires a
complete destination. Automatic and review importance sets cannot overlap.

The safe UI default is major automatic, normal review, and minor quiet. A
disabled or missing configuration publishes nothing.

## Atomic publication outbox

Workspace Memory mutation and publication enqueue run in one workspace-RLS
transaction. The outbox row freezes:

- exact configuration revision, connection, team, and channel;
- source type/id/version and source idempotency key;
- a stable hash of the bounded projection;
- importance and automatic/review mode;
- immutable operation id;
- frozen initiator kind/subject, initiating human, session, turn, and attempt
  identifiers when available.

Idempotency is unique per workspace, configuration revision, and source key. A
retry with the same input replays the existing row. Reusing a key with a
different source or projection is rejected. Configuration changes never retarget
already-queued work: the delivery worker cancels it if the current revision no
longer exactly matches.

## Attempts, receipts, and delivery

The API process runs a bounded outbox pump. It claims one eligible row through a
security-definer `FOR UPDATE SKIP LOCKED` function, increments the attempt count,
and appends an immutable `delivery_claimed` receipt. Expired claims are safely
reclaimed after process failure.

Delivery revalidates the exact verified workspace bot and uses the existing
Slack post-operation idempotency fence. Provider success records only the Slack
channel id and message timestamp. Transient errors enter exponential or
provider-directed retry wait; permanent errors and the eighth failed attempt
enter terminal failure. Exact configuration drift enters terminal cancellation.

Receipts are append-only and sequence every state transition:

- enqueue and optional review approval/rejection;
- delivery claim;
- scheduled retry;
- delivered, failed, or cancelled terminal state;
- an administrator-requested retry of a failed publication.

Configuration revisions and receipts reject updates/deletes. Publication source,
projection, destination, operation, and initiator identity reject mutation while
the bounded delivery state remains transitionable. All three tables use enabled
and forced workspace row-level security.

## Bounded Slack and history projections

Slack copy contains only the allowlisted summary, importance, optional owner,
occurrence time, governed destination/outcome where applicable, and a link back
to the authoritative OpenGeni Memory or Workspace State view. It excludes raw
Memory content, durable-learning subject content, evidence, prompts, credentials,
and actor identifiers.

The Capabilities page exposes the recent publication state, attempt count,
bounded error code, timestamp, and latest receipt. Workspace administrators can
approve/reject review-pending rows and retry failed rows. Cancelled rows cannot
be rebound to a new configuration; a new authoritative outcome must enqueue
under the new revision.

## API and SDK

The authenticated workspace routes are under
`/v1/workspaces/:workspaceId/memory-slack-publications`:

- `GET|PUT /configuration` for immutable configuration history/current revision;
- `GET /channels?connectionId=...` for eligible verified bot-member channels;
- `GET /` for bounded delivery/receipt history;
- `POST /:publicationId/action` for revision-fenced approve, reject, or retry.

The public SDK exposes matching typed methods. Workspace reads require
`workspace:read`; configuration and actions require `workspace:admin`.

Release, deployment, and production Slack acceptance are separate operational
steps and are not claimed by this source change.