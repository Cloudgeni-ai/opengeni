<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may have moved. Code wins.

# Session event append hot-path redesign

Status: proposed architecture and measurement plan.

Baseline source: `88c1155ce490e31a84719fa4900316dc0ee9b728`
(2026-08-28).

## Goal

Reduce session-event append p95 dramatically without weakening:

- exact committed per-session sequence order;
- client and producer idempotency;
- account/workspace isolation under FORCE RLS;
- workspace-control fairness and lock order;
- exact turn-generation and attempt fencing;
- durable rejected-late audit evidence;
- atomic lifecycle projections and existing domain outboxes;
- durable-before-live-publication truth; or
- recovery after a process dies between commit and publication.

The target is not “fewer locks.” The target is a shorter, narrower critical
section with one explicit owner for sequence and append admission.

## Confidence legend

- **Confirmed in source**: follows directly from the baseline implementation.
- **Measured historically**: retained aggregate measurements exist, but not a
  current production lock snapshot.
- **Strong hypothesis**: source shape makes this a likely latency contributor;
  phase telemetry or PostgreSQL evidence is still required to attribute current
  p95.
- **Unproven**: do not optimize until a benchmark or incident capture supports
  it.

## Executive finding

The current accepted-attempt append path combines four responsibilities in one
long transaction:

1. establish and verify tenant context;
2. evaluate generalized workspace/session control state;
3. own exact session sequence and turn-attempt admission; and
4. update event, session, monitoring, startup, and realtime projections.

A raw-delta append executes at least 19 SQL statements plus transaction control.
A semantic append executes at least 27. The exact count grows for startup
milestones, usage deduplication, delegation projection, actor RLS context,
domain mutations, retries, and rejected-late activity escalation.

The canonical lock prefix is correct, but too much work happens after it starts.
In particular, accepted-attempt append calls the full `evaluateSessionControl`
projection while holding the session, turn, and attempt rows. That projection
executes three queries. Two recursively compute settlement-attempt and stopping
background-command aggregates that append admission never reads.

The immediate defect is therefore more specific than “PostgreSQL is slow” or
“the sessions row is contended”:

> Generalized control/read-model work and repeated client/server protocol
> round trips execute inside the same-session write critical section.

The deeper ownership defect is that the wide `sessions` row owns both product
projection and the event sequence mutex. Every writer that needs the next
sequence must lock and dirty that aggregate.

## Evidence

### Historical measurement

Before the ordered nonblocking batch drain was introduced, production
evidence showed singleton-dominated flushes and multi-second inter-delta gaps.
Exact operator evidence remains in private retention. The current batcher
preserves one ordered drain while allowing deltas to accumulate behind an
in-flight flush, with a 33 ms trailing window, a 50-event batch limit, and a
1,000-event high-water mark.

That fix removed model-stream backpressure caused by awaiting every flush. It
did not shorten the database transaction itself.

### Current write path

`appendAndPublishTurnEventsFenced` measures the complete database helper as one
append duration, then measures NATS publication separately. The worker claim
path calls it from one serialized runtime batch drain.

The database helper:

1. resolves account identity from the workspace;
2. opens an RLS-scoped transaction;
3. configures and verifies transaction-local tenant and protocol GUCs;
4. takes the shared session-tenancy advisory fence;
5. optionally opens the session-activity gate;
6. takes the workspace-control advisory and row prefix;
7. locks workspace, session, exact turn, and exact attempt in canonical order;
8. evaluates effective control;
9. checks exact-attempt interruption state;
10. converts a rejected callback to durable `turn.event.rejected_late` evidence;
11. inserts the event batch;
12. projects optional startup and realtime state;
13. updates `sessions.last_sequence`; and
14. finalizes semantic activity immediately before commit.

### Code ownership map

| Responsibility | Current owner | Redesign owner |
| --- | --- | --- |
| Runtime coalescing and one ordered drain | `apps/worker/src/activities/streaming.ts` — `createRuntimeBatcher` | Keep; add batch/queue attribution only |
| Claimed-attempt event submission | `apps/worker/src/activities/agent-turn/claim.ts` — `eventing.publish` | Keep call boundary; route to the v2 adapter |
| Durable append then live publication | `packages/events/src/index.ts` — `appendAndPublishTurnEventsFenced` | Add durable fanout result and stop direct publish after outbox cutover |
| Exact attempt append transaction | `packages/db/src/index.ts` — `appendSessionEventsForTurnAttempt` and `mutateAndAppendSessionEventsForTurnAttempt` | Own the v2 adapter and typed result |
| Attempt admission fence | `packages/db/src/index.ts` — `lockTurnAttemptWriteFenceTx` | Split narrow admission from generalized control projection |
| Canonical event lock prefix | `packages/db/src/session-control.ts` — `lockSessionEventWriteRows` | Add narrow append locks; later insert the write head in canonical order |
| Effective control read model | `packages/db/src/session-control.ts` — `evaluateSessionControl(s)` | Keep for UI/read callers; add write-admission-only evaluator |
| Tenant transaction setup | `packages/db/src/database.ts` — `withRlsContext` and workspace wrappers | Add phase hooks; collapse protocol calls only with backend-pinning proof |
| Semantic activity finalization | `packages/db/src/database.ts` — session activity gate | Preserve initially; optimize independently |
| Event constraints and indexes | `packages/db/src/schema.ts` — `sessionEvents` | Add head/outbox schemas without weakening existing uniqueness |
| PostgreSQL migrations | `packages/db/drizzle/` | Add FORCE-RLS head, policies, functions, outbox, and bounded backfill |
| Append latency metric | `apps/worker/src/observability-metrics.ts` | Add pool, phase, lock, parity, and outbox metrics |
| Lock-order regression coverage | `packages/db/test/session-event-lock-order.test.ts` | Extend for narrow head and control cutover races |

### Canonical lock order

The current order is:

```text
session-tenancy:<workspace> advisory SHARE
  -> workspace-control:<workspace> advisory SHARE/UPDATE
  -> workspace_inference_controls FOR SHARE/UPDATE
  -> workspaces FOR KEY SHARE
  -> sessions FOR NO KEY UPDATE, UUID ordered
  -> session_turns FOR UPDATE, UUID ordered
  -> session_turn_attempts FOR UPDATE, UUID ordered
```

The workspace-control advisory lock is required for FIFO fairness. PostgreSQL
row-lock behavior otherwise permits new sharers to pass a waiting exclusive
control mutation. Ordinary accepted-attempt append must continue to take the
shared prefix; Pause, Resume, Cancel, and other genuine control changes continue
to take it exclusively.

The existing regression test proves that the shared workspace prefix does not,
by itself, serialize unrelated sessions in one workspace. Same-session writers
remain deliberately serialized.

### Exact attempt fence

The fence fails closed unless all of these remain true while their rows are
locked:

- the effective control state is active;
- `sessions.active_turn_id` is the supplied turn;
- the turn execution generation matches;
- the turn active-attempt pointer matches;
- account/session/turn ownership is internally consistent;
- attempt state is `claimed` or `running`;
- the attempt authority snapshot is complete;
- that snapshot still matches the session authority;
- no pending, delivered, or acknowledged attempt interruption exists; and
- the turn remains `running` or `requires_action`.

A failed fence does not silently drop the callback. The same transaction appends
`turn.event.rejected_late` with its rejected type, payload, expected generation,
attempt id, current owner facts, and rejection reason.

### Guaranteed statement budget

The lower bound below is for a normal accepted batch with no actor-specific RLS
context and no optional projection work.

| Phase | Raw batch | Semantic batch | Lock held after workspace-control prefix? |
| --- | ---: | ---: | --- |
| Resolve account from workspace | 1 | 1 | no |
| Configure RLS/writer GUCs | 4 | 4 | tenancy advisory only after setup |
| Session-tenancy advisory lock | 1 | 1 | tenancy |
| Verify RLS context | 1 | 1 | tenancy |
| Open activity gate | 0 | 1 | tenancy |
| Workspace-control advisory + row | 2 | 2 | yes |
| Workspace/session/turn/attempt rows | 4 | 4 | yes |
| Effective-control projection | 3 | 3 | yes |
| Exact-attempt interruption lookup | 1 | 1 | yes |
| Event batch insert | 1 | 1 | yes |
| Session sequence/projection update | 1 | 1 | yes |
| Commit-boundary RLS assertion | 0 | 1 | yes |
| Activity finalization | 0 | 6 | yes |
| **Guaranteed total** | **19** | **27** | |

`BEGIN`/`COMMIT` are not included. Neither are optional startup-ledger queries,
usage deduplication, realtime delegation projection, a domain mutation callback,
savepoints, retries, or trigger/constraint-internal SQL.

The lock-critical lower bound is 12 statements for raw append and 19 statements
for semantic append. A slow recursive query, backend queue, constraint flush, or
storage operation therefore lengthens the queue for every later writer to that
session.

### Discarded control work

`lockTurnAttemptWriteFenceTx` reads only:

- `effectiveControl.state`; and
- whether the primary blocker is workspace- or session-scoped, to select the
  rejection reason.

The generic `evaluateSessionControls` implementation also computes:

- recursively aggregated settlement-attempt counts; and
- recursively aggregated stopping background-command counts.

Those results are not used by append admission. They are read-model/UI facts
that currently add two recursive statements to every fenced flush while the
write rows are held.

### Wide locked rows

`lockSessionEventWriteRows` selects complete workspace, session, turn, and
attempt rows. The accepted-attempt fence needs only a bounded subset of their
columns. Full JSON metadata, policy snapshots, and unrelated projection fields
are transferred and decoded while the critical section is active.

This is a source-confirmed inefficiency. Its latency contribution remains
unmeasured.

### Pool pressure

The database client defaults to ten connections. A turn-worker comment records
that all ten can be occupied by live turns, which is why readiness has a separate
single-connection pool. API replicas use a 32-connection pool. With the default
two API, two control-worker, and four turn-worker replicas, the configured
general pools permit roughly 124 connections before readiness and auxiliary
services.

The append histogram begins before pool acquisition and has no phase or pool
labels. Pool starvation is therefore a strong hypothesis, not a measured root
cause.

### Activity serialization

Semantic writes finalize through one
`workspace_session_activity_revisions` counter row and then stamp all session
rows marked by the transaction. That creates a short workspace-level commit
serialization point. It is secondary rather than the sole cause: the unrelated
session concurrency regression proves another session can progress before one
transaction reaches finalization.

## Proposed architecture

The rollout has two performance steps and two durability/isolation steps. Each
step is independently measurable and reversible until ownership cutover.

### Step 1: specialized append admission

Add an internal append-specific control evaluator that returns only:

```ts
type SessionWriteAdmissionControl = {
  state: "active" | "paused";
  blockerScope: "workspace" | "session" | null;
  controlVersion: number;
};
```

It must reuse the already locked workspace-control row and load only the
session-ancestry fields required to determine pause/override state. It must not
compute settlement or background-command summaries.

Also add an append-specific lock helper that selects only the columns needed by
the exact fence. Do not weaken lock modes or reorder tables.

Expected immediate changes:

- two recursive queries removed per accepted-attempt batch;
- fewer bytes decoded under lock;
- no semantic or schema change;
- the current audit, RLS, control, and late-event behavior remains unchanged.

This step should ship before a schema ownership change so its effect can be
measured independently.

### Step 2: one database-call append command

Introduce application-role, `SECURITY INVOKER` database functions for the
canonical append shapes:

```text
append_session_event_batch_v2
append_turn_attempt_event_batch_v2
mutate_and_append_turn_attempt_event_batch_v2
```

The ordinary worker call should send one bounded event batch and receive one
typed result:

```ts
type AppendTurnAttemptBatchResult = {
  accepted: boolean;
  rejectionReason: TurnAttemptFenceRejectReason | null;
  events: SessionEvent[];
  canonicalStartupMilestones: CanonicalTurnStartupMilestoneReceipt[];
  firstSequence: number;
  lastSequence: number;
  fanoutBatchId: string;
};
```

The function remains inside the caller's transaction and performs the same
ordered operations server-side. It must not commit, publish, call external
services, or bypass FORCE RLS.

Database grants:

- revoke function execution from `PUBLIC`;
- grant only to the ordinary application role;
- retain `SECURITY INVOKER`;
- pin the function search path;
- qualify every relation;
- let FORCE RLS apply to every table access; and
- verify the supplied workspace/account pair before mutation.

The function collapses client/server protocol latency; it does not justify
removing the lock prefix. External effects remain outside retryable database
transactions.

### Step 3: narrow canonical write head

Create a FORCE-RLS table whose row is the one per-session event mutex:

```sql
CREATE TABLE session_event_write_heads (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  last_sequence bigint NOT NULL,
  active_turn_id uuid,
  active_execution_generation integer,
  active_attempt_id uuid,
  authority_epoch bigint NOT NULL,
  authority_snapshot_hash bytea NOT NULL,
  effective_control_state text NOT NULL,
  effective_control_version bigint NOT NULL,
  effective_control_blocker_scope text,
  write_fence_epoch bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
);
```

Exact column types and checks follow the canonical source tables. The important
ownership boundaries are:

- `last_sequence` owns transactional, gap-free committed sequence allocation;
- active turn/generation/attempt and authority facts own fast append admission;
- effective control facts own the pause boundary observed under the shared
  workspace-control prefix; and
- `write_fence_epoch` gives lifecycle writers and parity checks a monotonic
  concurrency receipt.

The wide `sessions` row remains product and query projection. It no longer needs
to be updated merely to reserve event sequence numbers.

#### Control projection correctness

Control mutations are rare relative to streaming appends. Under the exclusive
workspace-control prefix they must:

1. update canonical workspace/session control records;
2. recompute the affected branch's effective write-admission facts;
3. update affected write-head rows and increment their fence epochs; and
4. commit control events and wake/outbox facts atomically.

An append that obtained the shared prefix first commits before the mutation.
A mutation that obtained the exclusive prefix first updates the head before a
later append can obtain the shared prefix. This preserves the existing total
order across Pause, Resume, Cancel, settings narrowing, and other control
boundaries.

Do not copy UI-only settlement/background summaries into the write head. The
append fence does not consume them. Exact-attempt interruption remains a narrow
indexed check initially; it may move to a head counter only after every creator,
delivery, acknowledgement, settlement, and stale-rejection transition is proven
to update that counter atomically.

#### New canonical lock order

```text
session-tenancy:<workspace> advisory SHARE
  -> workspace-control:<workspace> advisory SHARE/UPDATE
  -> workspace_inference_controls FOR SHARE/UPDATE
  -> workspaces FOR KEY SHARE
  -> session_event_write_heads FOR UPDATE, UUID ordered
  -> session_turns FOR UPDATE, UUID ordered
  -> session_turn_attempts FOR UPDATE, UUID ordered
```

Lifecycle writers that also update the wide session row must lock the write head
before that update. No path may lock `sessions` and then request the write head.
The migration must inventory and convert every sequence/lifecycle writer before
head ownership becomes authoritative.

#### Sequence semantics

Do not use a PostgreSQL sequence object. Database sequences are not rolled back
and would introduce committed timeline gaps.

The write-head row is incremented in the same transaction as the event insert:

```sql
UPDATE session_event_write_heads
SET last_sequence = last_sequence + cardinality(input_events),
    updated_at = clock_timestamp()
WHERE workspace_id = input_workspace_id
  AND session_id = input_session_id
RETURNING last_sequence - cardinality(input_events) + 1 AS first_sequence,
          last_sequence AS last_sequence;
```

The function assigns the returned contiguous range in input order. Rollback
returns ownership of the range because both the head update and inserts roll
back together.

### Step 4: durable batch fanout outbox

Generic session-event publication is currently best-effort NATS after the
database commit. Replay remains durable, but a process death can omit the live
notification until a reader detects a gap.

Add one outbox row per committed event batch:

```sql
CREATE TABLE session_event_fanout_outbox (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  first_sequence bigint NOT NULL,
  last_sequence bigint NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  UNIQUE (workspace_id, session_id, first_sequence, last_sequence)
);
```

Insert it in the same transaction as the event batch. A bounded dispatcher:

1. claims rows with `FOR UPDATE SKIP LOCKED`;
2. reads the exact durable event range;
3. publishes one ordered batch to NATS;
4. marks the row published; and
5. retries with bounded backoff after an ambiguous or failed publication.

Delivery is at least once. Consumers continue to deduplicate by event identity
and sequence. PostgreSQL remains audit truth; NATS never becomes sequence or
admission authority.

Existing workflow-wake, child-lifecycle, artifact, and domain outboxes remain
unchanged and commit in their current lifecycle transactions.

### Step 5: bounded connection lanes

Divide the existing total connection budget rather than increasing it blindly:

- append/lifecycle lane;
- interactive API lane;
- background/general lane; and
- readiness lane.

The append lane must be large enough for admitted turn concurrency but bounded
so streaming cannot consume every backend. General/background work must not be
able to queue ahead of all append writers in one client pool.

The deployment must calculate the sum across replicas and auxiliary services
against the database/server or pooler connection budget. Runtime configuration
must expose that calculation in deployment evidence.

## Invariant matrix

| Invariant | Design mechanism | Required proof |
| --- | --- | --- |
| Exact session order | One locked write head allocates one contiguous transactional range | Concurrent append test asserts unique, gap-free, input-ordered committed sequences |
| Client idempotency | Existing unique client-event identity remains authoritative | Concurrent identical retry returns the canonical event and consumes no second sequence |
| Producer idempotency | Existing producer-id/sequence uniqueness remains authoritative | Retry and cross-worker race converge on one canonical event |
| FORCE RLS | Head, events, and outbox use account/workspace policies; functions are invoker-rights | Forged account/workspace and cross-tenant direct calls return no rows or fail |
| Workspace-control order | Shared/exclusive advisory + row prefix remains first | Pause/Resume/Cancel races show either append-before-control or rejection-after-control, never crossing |
| Active-turn fence | Head and exact turn locks agree on active identity | Turn replacement race cannot admit the prior turn |
| Generation/attempt fence | Head, turn, and attempt identities must match | Replacement attempt and generation races produce rejected-late evidence |
| Authority fence | Head hash/epoch agrees with immutable attempt snapshot and current session authority | Revocation/visibility-owner transitions fail closed |
| Pending interruption fence | Indexed exact-attempt interruption check remains under the same transaction | Pending/delivered/acknowledged interruption always rejects current admission |
| Late-event audit | Rejection is transformed and appended through the same sequence owner | Rejected payload and reason are durable and ordered exactly once |
| Atomic mutation/projection | Domain mutation, events, head, projections, and existing outboxes share one transaction | Injected failures at every boundary leave all-or-nothing durable state |
| Durable publication | Fanout outbox commits with events | Kill after commit/before publish and prove eventual ordered publication |
| Retry safety | Only `40P01`/`40001`; no external effect inside retry | Fault-injected retries create no duplicate event, mutation, outbox, or provider effect |
| Activity truth | Existing activity gate remains until independently replaced | Semantic events advance monitoring exactly once; raw deltas do not |

## Migration plan

### Phase 0: attribution telemetry

Add pool-acquisition and append-phase metrics before changing behavior. Run one
release long enough to obtain p50/p95/p99 and wait attribution by append class.

Exit gate:

- worker metrics are queryable centrally;
- pool wait and transaction time are separate;
- lock, control projection, insert, activity finalization, and commit are
  individually visible; and
- no high-cardinality labels exist.

### Phase 1: specialized current-schema fast path

- Replace generalized control projection in accepted-attempt append with the
  narrow admission evaluator.
- Select only required fence columns.
- Preserve current tables, sequence owner, locks, retries, and publication.

Exit gate:

- all existing lock-order/RLS/fence tests pass;
- statement count falls by at least two per batch;
- append p95 improves without increased control-mutation wait or deadlocks; and
- rejected-late results are byte-for-byte equivalent after bounded fields are
  normalized.

### Phase 2: server-side append command

- Add invoker-rights functions and typed adapters.
- Run old and new implementations under a percentage flag.
- In shadow mode, execute the new read/fence planning path without writing and
  compare admission facts.

Exit gate:

- one client call performs append work;
- old/new admission decisions have zero unexplained divergence;
- transaction retry and timeout behavior is equivalent; and
- no privileged function or RLS bypass exists.

### Phase 3: write-head introduction

- Create FORCE-RLS write-head table and policies.
- Backfill under a bounded migration from sessions, active turns, attempts, and
  effective control state.
- Add dual-write lifecycle updates.
- Keep `sessions.last_sequence` authoritative initially.
- Continuously compare head/session sequence and fence facts.

Exit gate:

- every session has exactly one head;
- parity has zero drift for a complete observation window;
- every sequence/lifecycle writer is inventoried and dual-writing; and
- rollback to session ownership remains possible.

### Phase 4: sequence ownership cutover

- Allocate new ranges from the write head.
- Continue shadow-updating `sessions.last_sequence` for rollback evidence.
- Route a small workspace cohort, then a percentage of sessions, then the fleet.

Abort automatically on:

- any sequence gap, duplicate, or head/session regression;
- any old/new fence-decision divergence;
- RLS policy failure;
- deadlock or serialization-retry regression;
- rejected-late regression; or
- activity/outbox atomicity failure.

### Phase 5: durable fanout outbox

- Create and backfill no historical rows; only new batches need publication
  ownership.
- Dual-publish directly and through the outbox for a bounded canary while
  consumers deduplicate.
- Disable direct publication after dispatcher lag and duplicate behavior are
  proven.

### Phase 6: projection retirement

- Stop shadow-updating `sessions.last_sequence`.
- Retain parity telemetry and the column through at least one full rollback and
  retention window.
- Remove obsolete sequence ownership only in a later drained migration.

## Telemetry

### Histograms

```text
opengeni_db_pool_acquire_seconds{lane,outcome}
opengeni_session_event_append_phase_seconds{
  path,event_class,batch_size_class,phase,outcome
}
opengeni_session_event_lock_wait_seconds{lock_class,outcome}
opengeni_session_event_transaction_seconds{path,event_class,outcome}
opengeni_session_event_fanout_seconds{outcome}
```

Closed `phase` values:

```text
workspace_context
rls_setup
tenancy_lock
workspace_control_lock
session_head_lock
turn_attempt_fence
control_projection
idempotency
event_insert
projection
activity_finalize
outbox
commit
```

### Gauges and counters

```text
opengeni_db_pool_active{lane}
opengeni_db_pool_idle{lane}
opengeni_db_pool_queued{lane}
opengeni_db_pool_timeouts_total{lane}
opengeni_session_event_retries_total{sqlstate}
opengeni_session_event_rejected_late_total{reason}
opengeni_session_event_fanout_pending
opengeni_session_event_fanout_oldest_seconds
opengeni_session_event_fanout_retries_total{outcome}
opengeni_session_event_head_parity_failures_total{kind}
```

Never label metrics by account, workspace, session, turn, attempt, event id,
event type, model, or user-supplied value. Those identities belong only in
access-controlled logs and traces.

## PostgreSQL incident capture

Run the following during the same interval used for append p95.

### Blocked/backend ownership

```sql
SELECT
  blocked.pid AS blocked_pid,
  blocked.application_name AS blocked_application,
  blocked.wait_event_type,
  blocked.wait_event,
  clock_timestamp() - blocked.query_start AS blocked_for,
  pg_blocking_pids(blocked.pid) AS blocking_pids,
  left(blocked.query, 500) AS blocked_query
FROM pg_stat_activity AS blocked
WHERE blocked.datname = current_database()
  AND cardinality(pg_blocking_pids(blocked.pid)) > 0
ORDER BY blocked.query_start;
```

### Hot relation locks

```sql
SELECT
  activity.pid,
  activity.application_name,
  locks.locktype,
  locks.mode,
  locks.granted,
  relation.relname,
  activity.wait_event_type,
  activity.wait_event,
  clock_timestamp() - activity.xact_start AS transaction_age,
  left(activity.query, 300) AS query
FROM pg_locks AS locks
JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
LEFT JOIN pg_class AS relation ON relation.oid = locks.relation
WHERE relation.relname IN (
  'sessions',
  'session_turns',
  'session_turn_attempts',
  'session_events',
  'workspace_inference_controls',
  'workspace_session_activity_revisions'
)
ORDER BY locks.granted, activity.xact_start;
```

### Statement cost

```sql
SELECT
  calls,
  round(total_exec_time::numeric, 2) AS total_ms,
  round(mean_exec_time::numeric, 2) AS mean_ms,
  round(max_exec_time::numeric, 2) AS max_ms,
  rows,
  shared_blks_hit,
  shared_blks_read,
  temp_blks_written,
  left(query, 500) AS query
FROM pg_stat_statements
WHERE query ILIKE ANY (ARRAY[
  '%session_events%',
  '%session_turn_attempts%',
  '%session_attempt_interruptions%',
  '%session_background_commands%',
  '%workspace_session_activity_revisions%',
  '%workspace_inference_controls%'
])
ORDER BY total_exec_time DESC
LIMIT 50;
```

Capture at one-second intervals for at least five minutes. Retain PID, blocker
PID, application name, wait class, query fingerprint, and transaction age.
Do not retain event payloads or tenant content.

## Benchmark plan

Use PostgreSQL with the production schema, indexes, triggers, FORCE RLS role,
and transaction-pool-compatible driver settings. Run current and candidate code
against the same restored data shape.

### Matrix

1. One session, one ordered raw-delta writer.
2. One session, structural/semantic batches.
3. One session racing Pause, Resume, Cancel, Steer, and attempt replacement.
4. One session with duplicate client and producer identities.
5. 100 independent sessions in one workspace.
6. 100 sessions spread across ten workspaces.
7. Deep session ancestry with active and defeated pause boundaries.
8. Pending/delivered/acknowledged interruption races.
9. Startup-milestone and model-usage deduplication batches.
10. Domain mutation plus event plus existing outbox atomicity.
11. Commit-before-NATS process termination.
12. General-pool saturation while append-lane traffic continues.
13. Deadlock and serialization fault injection.
14. Outbox dispatcher restart and duplicate publication.

Run batch sizes 1, 10, and 50. Test at one, four, and the deployment's maximum
admitted turn concurrency per worker.

### Performance gates

| Measurement | Gate |
| --- | ---: |
| Client database calls for ordinary append | 1, excluding transaction protocol if the driver cannot combine it |
| Generalized recursive control queries per append | 0 |
| Pool acquisition p95 | <10 ms |
| Uncontended write-head lock wait p95 | <5 ms |
| Raw batch transaction p95 | <75 ms |
| Semantic batch transaction p95 | <125 ms |
| 100-session same-workspace scaling | at least 90% of linear throughput |
| Append p99 alert threshold | <1 s with no sustained firing |
| Fanout oldest pending age | <5 s in steady state |

Performance gates never override correctness gates.

### Correctness gates

- zero committed sequence gaps or duplicates;
- zero admitted stale-generation or stale-attempt events;
- exactly one durable rejected-late event per rejected input;
- zero cross-workspace or cross-account visibility;
- zero unexplained old/new admission divergence;
- zero lost committed publications after outbox drain;
- no external effect replay under database retry;
- no workspace-control starvation regression;
- no deadlock-rate regression; and
- exact semantic/raw activity behavior.

## Rollback

Before write-head cutover, disable the specialized adapter or database-command
flag and return to the current implementation.

During dual-write, `sessions.last_sequence` remains authoritative and head rows
may be rebuilt.

After head cutover, rollback is allowed only while every append still
shadow-updates `sessions.last_sequence` and parity is green. A parity failure
freezes rollout and forbids automatic ownership reversal until the mismatch is
classified; switching between divergent sequence owners can create duplicate
or reordered events.

The fanout outbox is additive. If its dispatcher is disabled, durable events and
stream replay remain authoritative. Direct best-effort publication may be
temporarily re-enabled only while consumers continue to deduplicate.

## Decision register

| Decision | Rationale |
| --- | --- |
| Keep the workspace-control advisory and row prefix | It preserves FIFO control fairness and an exact append/control boundary. |
| Remove UI-only settlement projections from append | Their results are discarded by the fence and add recursive work under lock. |
| Keep exact turn and attempt locks | They make generation, attempt, authority, and terminal-state checks atomic. |
| Move sequence ownership off `sessions` | Sequence allocation should not dirty or convoy on the wide product aggregate. |
| Use a transactional row counter, not a database sequence | Committed session timelines must remain gap-free. |
| Use invoker-rights database functions | One protocol call is useful; privileged RLS bypass is not. |
| Keep PostgreSQL as audit truth | Live delivery is recoverable fanout, never admission or ordering authority. |
| Add a durable batch outbox | It closes commit-before-publish loss without putting NATS inside a retryable transaction. |
| Preserve the activity gate initially | Its semantics are independent and must be optimized only with separate evidence. |
| Partition connection lanes under one budget | Isolation prevents unrelated work from consuming every append connection. |

## Current proof boundary

Source evidence proves:

- exact lock and query ownership;
- the 19/27-statement lower bounds;
- discarded recursive control work under lock;
- wide session-row sequence ownership;
- absence of pool-acquisition and phase telemetry; and
- preservation requirements for RLS, control, attempts, audit, activity, and
  publication.

The current workspace has no authenticated database, Kubernetes, or
observability connection. Therefore it does not prove the current production
percentage attributable to client-pool queueing, advisory/row locks, recursive
query execution, storage I/O, or commit latency. Phase telemetry and the
PostgreSQL incident capture above are release prerequisites, not optional
follow-up work.