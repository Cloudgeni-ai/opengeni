# Session-tree archival contract

Status: OPE-61 implementation contract. This document describes generic product
behavior only. Recovery manifests, dispositions, receipts, and production
evidence are deliberately not part of the public repository.

## 1. State model

Archival is an orthogonal execution fence. It is not a lifecycle `status`, a
pause, stop, cancellation, title change, sandbox filesystem snapshot, deletion,
or client-side filter. A session keeps its status, control state, history, goal,
lineage, and all evidence while archived.

Each session has a monotonic `archiveRevision` and an indexed effective
`archived` projection. An archive creates an immutable **seal** for one recursive
root and immutable membership rows for the exact locked closure. Releasing that
seal is unarchive. Independent overlapping seals are allowed; a session remains
effectively archived until every seal covering it has been released. Adding or
releasing a membership increments the member session's revision, including when
another seal keeps its effective state unchanged. A released seal is never
reactivated; a later archive creates a new seal and evidence chain.

This overlap rule makes reversibility exact:

1. archive child C;
2. archive ancestor A;
3. unarchive A;
4. C remains archived by its independent seal;
5. unarchive C releases the final fence.

Archive/unarchive operations, seals, memberships, and per-member before/after
revisions are append-only audit evidence. Effective projection columns are the
only denormalized values and must agree with active membership count.

## 2. Locking and atomicity

Every archive apply transaction follows the canonical writer prefix introduced
by OPE-63:

1. workspace inference-control row (`FOR UPDATE` for archive apply);
2. workspace row (`FOR KEY SHARE`);
3. exact session closure, UUID ordered (`FOR UPDATE`);
4. exact turns, UUID ordered (`FOR UPDATE`);
5. exact attempts, UUID ordered (`FOR UPDATE`);
6. feature-owned rows in a documented stable order.

Session creation deliberately does **not** copy that entire prefix. OPE-53's
authoritative creation transaction has a stricter established order:

1. workspace inference-control row (`FOR SHARE`);
2. workspace validation without a workspace-row lock;
3. deployment depth-policy singleton (`FOR SHARE`);
4. keyed-create advisory lock and committed success/denial replay, when keyed;
5. direct parent plus the OPE-61 ancestry fence in one deterministic order;
6. admission decision and either durable typed denial or session insert.

Adding a workspace-row lock after the control row would invert the depth-policy
settings writer and is forbidden. Moving the keyed-create advisory lock after
parent/ancestry locks is also forbidden. OPE-61 composes at the private OPE-53
admission boundary rather than adding an HTTP-, MCP-, or SDK-only preflight.
The archive writer's `FOR UPDATE` control lock conflicts with creation's
`FOR SHARE` control lock. The ancestry guard then reads and locks the canonical
archive state before insert. If the integrated implementation locks multiple
ancestors, create and archive both use the same root-to-leaf deterministic order
and never walk leaf-to-root. Consequently an archive cannot miss a concurrent
child: either creation commits first and appears in the locked closure, or
archive commits first and creation records one `archived_ancestry` denial.
The rolling old-writer database guard participates in the same serialization;
an application-only check is insufficient.

The recursive closure is recomputed after locks are acquired and compared with
the manifest's exact `(sessionId, parentSessionId, depth, archiveRevision,
archived)` members. Missing, extra, reparented, or revision-changed members fail
the entire root transaction. No seal, membership, session projection, queue,
goal, lease, wake, event, or receipt is partially changed on rejection.

Each root in a bulk manifest is an independent atomic batch. Bulk progress is
resumable between roots, never within one tree.

## 3. Live-work policy

The first implementation uses the issue's permitted **explicit rejection**
policy. Archive never disguises pause/cancel/stop as settlement and never drops
work. A locked closure is rejected with sorted typed blockers if it contains any
of the following:

- queued, running, approval, recovery, or capacity-waiting turns;
- an open/current execution attempt or an admitted worker claim;
- queued human/API prompts, deferred internal updates, child-completion
  callbacks, or pending workflow-wake delivery;
- an active goal or goal continuation wake;
- an active durable wait, asynchronous/background job, schedule fire, or a
  scheduled task that would reuse a member session;
- a live sandbox operation, viewer, PTY, exclusive lease ownership, recovery,
  rematerialization, or route switch attributable to a member;
- any adjacent subsystem's invariant-broken state that cannot be proven settled.

Operators settle work through the owning first-class command (for example,
complete/pause a goal, explicitly stop/cancel a turn, close a PTY, or pause a
schedule), then regenerate the manifest. Archive itself does not perform those
mutations. This makes every side effect visible and keeps the archive transaction
bounded and rollback-safe.

Subsystem composition is fail-closed and uses owner-provided seams:

- any `active` goal is a blocker even when its observed and wake revisions are
  equal; archive never clears the shared workflow-wake outbox, advances an
  observed revision, or edits goal status directly;
- `waiting` durable waits and `queued`, `starting`, `running`, or `cancelling`
  background jobs are blockers; unknown future wait kinds or job states also
  block until the owning subsystem defines their settlement contract;
- an active or indeterminate sandbox lease/provider attachment is a blocker.
  Archive never reuses provider-`NOT_FOUND` loss helpers, and an external
  read-then-retire preflight is not sufficient. Lease admission,
  rematerialization, attach/swap, viewer, PTY, and route establishment must read
  the ancestry fence inside their authoritative transaction before side
  effects. The archive transaction locks affected lease rows only after the
  canonical archive/session prefix and rolls back the entire root on a blocker.

## 4. Fail-closed execution boundary

The effective fence is inherited: a session is execution-blocked when it or any
ancestor is effectively archived. All execution/mutation admission paths return
one typed model-readable denial containing at least:

- `code: "session_archived"` or `code: "archived_ancestry"`;
- target session and the nearest archived ancestor;
- ancestor `archiveRevision` and active seal identifier;
- attempted operation category;
- `retryable: false` until an authorized unarchive.

Denied paths create no queue row, turn, attempt, event, wake, job, callback,
sandbox operation, lease, PTY, viewer, goal revision, schedule run, or child
session. Reads of durable evidence remain allowed to authorized callers.

Application guards provide typed errors and database guards protect rolling
deployments from old writers. At minimum the database guard covers child
creation, session lifecycle/control writes, queue/turn/attempt/event/outbox/goal
writes, waits/jobs/schedule reuse, and sandbox route/lease/PTY writes. A stale
wake that reached the workflow before the archive commit still cannot claim
work after the commit because claim admission rechecks the same revision fence.

Unarchive changes only seal membership, archive revision, effective projection,
and archival audit evidence. It does not alter lifecycle/control state, enqueue
or deliver a wake, resume a goal/schedule/job/wait, restore a sandbox, or start a
workflow. Resume is always a separate authorized command.

## 5. Reads and evidence

Ordinary list, search, total-count, tree-stat, pin snapshot, and discovery paths
use an indexed `archived = false` predicate by default. Explicit views are:

- `live` (default): only effectively unarchived sessions;
- `archived`: only effectively archived sessions, compact projection;
- `all`: both, for authorized operator inspection.

List cursors and subject snapshots bind their archive view; a cursor cannot be
replayed in another view. Exact lookup defaults to live and requires an explicit
archived/all view to reveal an archived row. Exact authorized evidence APIs may
then retrieve all retained lineage, events, messages, turns, goals, files,
attachments, usage/provenance, reviews, sandbox recovery metadata, and archive
receipts. Archiving does not rewrite, further truncate, or remove any of those
durable records. It cannot reconstruct generic tool output that was omitted or
truncated before archival: durable event payloads keep their existing
secret-redaction, lossiness, and byte-bound contracts, while separately retained
files and artifacts keep their existing access-controlled retrieval paths.

Compact discovery remains bounded by construction. Adding archive state must not
pull full evidence into list queries. Query plans and memory are acceptance
artifacts for both live and archived views. The model-facing compact list keeps
keyset pagination and server-side filtering, reads at most 101 base rows for a
100-row page, projects at most 100 roots, and remains within its 128 KiB encoded
response budget. It must not hydrate wide session objects or filter archived
rows client-side. The agent-side archived escape hatch is an authorized exact
lookup with an explicit archived/all view; it is not an unbounded archived-tree
mode on compact discovery. Human desktop/mobile archived browsing extends the
separately paginated and virtualized human list query without reusing full
session objects in the compact MCP projection.

## 6. Manifest and receipt protocol

Manifest v1 is structured JSON defined by
`packages/contracts/src/session-archive.ts`. Canonical bytes have fixed key
order, lower-case UUIDs, sorted roots/members, canonical decimal bigint
revisions, no whitespace, and no volatile actor/time fields. The approval fence
is `sha256:<64 lower-case hex>` over those UTF-8 bytes.

An archive root has `targetSealId: null`; an unarchive root names the exact seal
to release. Every member records expected parent, depth, archive revision, and
effective archived state. Explicit per-root and total counts defend against
truncated files. Duplicate members across bulk roots are rejected, so each
receipt has one unambiguous atomic owner.

Dry-run is read-only. It returns the canonical manifest/checksum, per-root
checksums, exact blockers, and coverage proof without creating an operation,
seal, receipt, event, or source mutation. Apply requires the caller-supplied
bulk checksum, one root id/checksum, and an idempotency key. The first committed
root for a bulk checksum supplies and durably registers the complete canonical
bulk manifest; that root's transaction both registers the immutable manifest
and applies the root or rolls both back. Later root applications and resumptions
may omit the manifest and address the registered operation by checksum. A
manifest-less request for an unknown checksum fails closed. This proves that
every independently applied root belongs to the approved bulk manifest without
resending a potentially million-member manifest for every root. The durable
receipt binds:

- workspace, action, root, target/new seal, manifest and per-root checksums;
- canonical request hash and idempotency key;
- exact ordered member set and before/after revisions/states;
- actor/grant subject and exact grant authority plus commit timestamp;
- blocker-free precondition proof and post-commit coverage checksum.

The wire receipt names `targetSealId` only for unarchive and `resultingSealId`
only for archive. `sealId` remains the compact compatibility alias for the one
non-null operation seal and must equal the action-appropriate explicit field.
`operationKey` and `idempotencyKey` likewise identify the same deterministic
per-root replay key. Coverage checksum v2 binds those fields, the canonical
request hash, authority tuple, precondition checksum, and the ordered durable
member evidence; the operator independently recomputes every envelope before
trusting a new or resumed receipt.

Replaying the same key and checksum returns the committed receipt. Reusing a key
with another request is a typed idempotency conflict. A stale checksum/revision
is a typed manifest conflict and has zero partial side effects. The operator can
resume by asking for receipts keyed by `(bulk checksum, root checksum)` and only
submitting missing roots. It must verify post-commit member coverage and
effective state before marking a root complete.

The generic operator is `bun run session-archive:operator -- plan|apply`. Plan
is read-only and writes the locally revalidated canonical plan to an
operator-supplied private path. Apply requires the exact approved checksum and a
second exact workspace-id confirmation, resumes only from fully verified
durable receipts, and writes a complete verified receipt-evidence bundle. The
CLI rejects manifest and evidence paths inside the public repository, accepts
authentication only through an environment variable, and normal progress
prints only aggregate counts rather than private manifest members or
credentials. It does not confer production authorization; deployment policy
must still grant the exact checksum and workspace operation.

## 7. Required acceptance evidence

Tests use isolated disposable canary trees only. They must cover real
PostgreSQL with `FORCE ROW LEVEL SECURITY`, cross-workspace denial, archive races
with every writer class, exact blocker rollback, overlapping seals, idempotent
replay, explicit unarchive without resume, rolling old/new writer denial,
workflow/wake/schedule/job/callback/lease fences, exact evidence checksums, and
bounded list/search plans. Browser acceptance covers desktop/mobile layout,
keyboard and screen-reader naming, focus restoration, archive confirmation,
explicit views, archived banners, and reversible unarchive.

Production and recovery-workspace manifests/evidence are private operational
artifacts. No production bulk apply occurs without an independently synthesized
exact manifest and explicit root-orchestrator authorization.