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
`packages/core/src/domain/governed-learning-slack-publication.ts` is a narrow
post-persistence consumer of the immutable migration 0269 activation and undo
receipts. The Company Brain learning-policy router calls it after an automatic
activation commits, and the `/learning/activations/:id/undo` route calls it
after an undo commits; both calls are best-effort and can never change the
durable receipts or the route receipt. The adapter reads no proposal content,
evidence bytes, or destination bodies: its projection is a fixed content-free
sentence plus destination, source kind, revision, receipt ids, and timestamps.
Preference activations are `normal` importance; instruction-policy activations
and every undo are `major`. For an activation it first resolves the evidence
origin (task note, or the knowledge provider key behind the document version)
and fails closed when the origin is unresolvable or Slack-derived, so
Slack-sourced knowledge can never republish itself. The idempotency key is
`governed-learning:<activated|undone>:<receiptId>` and the actor is the
receipt's service actor with the causal human retained as provenance.

The Workspace Memory path passes its allowlisted summary/owner/destination
text (the governed-learning path emits only a fixed template with enum labels
and numbers, so it has no free text to sanitize)
through the deterministic sink-local credential-shape boundary in
`packages/core/src/domain/slack-publication-secret-safety.ts` before the
projection is hashed or persisted. The final Slack formatter applies the same
boundary again before escaping and truncation as defense in depth. Recognized
credential forms are replaced with a fixed omission marker; canonical Memory,
governed-learning receipts, model history, events, and other internal
OpenGeni content remain exact and are never rewritten by this boundary.

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
Slack post-operation idempotency fence. After claiming that post identity and
immediately before `chat.postMessage`, it re-reads the exact channel and requires
the bot still to be a member, the channel still to be active, and all Slack
Connect/shared flags still to be false. Membership, archive, deletion, or shared
channel drift makes no provider post and enters terminal cancellation with an
explicit immutable error receipt. Provider success records only the Slack
channel id and message timestamp. Transient errors enter exponential or
provider-directed retry wait; permanent errors and the eighth failed attempt
enter terminal failure. Exact configuration drift also enters terminal
cancellation.

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
Memory content, governed-learning proposal content, evidence,
prompts, credential-shaped values, and actor identifiers. The same sanitized
summary is used by the persisted publication row and bounded delivery-history
projection, so review and history surfaces cannot reveal a value removed at the
Slack boundary.

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

The opt-in `@opengeni/sdk/memory-slack` client exposes matching typed methods
without adding this capability to the eager core client graph. Workspace reads
require `workspace:read`; configuration and actions require `workspace:admin`.

Release, deployment, and production Slack acceptance are separate operational
steps and are not claimed by this source change.
