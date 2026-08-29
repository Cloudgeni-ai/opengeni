# Session event sequencer architecture

Status: Phase C raw-lane isolation implemented; compatibility projection retained.

Date: 2026-08-28.

## Problem

`sessions.last_sequence` currently serves three unrelated roles:

1. public session metadata and unread-state projection;
2. the allocator for every durable event sequence; and
3. the serialization mutex for semantic events, raw token/reasoning deltas,
   turn-attempt fencing, and several session lifecycle mutations.

That coupling is correct but expensive. A raw stream batch takes the canonical
workspace/session/turn/attempt lock prefix, inserts its event rows, runs any
startup and realtime projections, updates the comparatively wide `sessions`
row, and commits. A concurrent writer for the same session waits behind that
whole transaction even when both writers need only exact event ordering.

Staging evidence on 2026-08-28 showed multi-second append tails while NATS
publish remained millisecond-scale. A bounded `pg_stat_activity` sample caught
transaction-id and tuple lock chains, including an event transaction between
its `session_events` insert and commit. Database CPU and I/O were not saturated.

## Invariants

The redesign may improve mechanics only. It must preserve:

- one gap-free, monotonically increasing sequence per session;
- durable event commit before live publication;
- exact current turn-attempt fencing for worker-produced events;
- idempotent retry and duplicate provider-usage semantics;
- FORCE RLS, account/workspace ownership, and existing audit payload truth;
- atomic semantic mutations and their corresponding timeline events;
- replay, SSE gap recovery, unread state, and API cursor behavior;
- no asynchronous sequence repair and no eventually consistent event order.

## Immediate diagnostic slice

The fenced worker append now reports bounded phase histograms for:

- mutation callback;
- attempt-fence acquisition;
- provider-usage dedupe;
- event insert;
- startup milestone projection;
- realtime delegation projection; and
- session cursor update.

The existing whole-append histogram still includes RLS setup, transaction
checkout, retry, and commit. The difference between the whole duration and the
sum of successful inner phases is therefore an intentional estimate of pool,
RLS, retry, and commit overhead. Diagnostics are callback-only, low cardinality,
and swallowed on failure so they cannot alter settlement.

## Target architecture

Introduce one compact, FORCE-RLS `session_event_cursors` row per session:

```text
(account_id, workspace_id, session_id, last_sequence, revision, updated_at)
```

The cursor row becomes the sole sequence allocator and ordering mutex. A writer
locks it after the workspace prefix and before any session/turn/attempt suffix,
claims one contiguous range, inserts exactly that range, and commits. The
`sessions` row stops changing for raw deltas and is locked only when the append
also changes semantic session state.

The final lock order is:

```text
workspace control advisory/row when required
→ workspace FOR KEY SHARE
→ session_event_cursors FOR UPDATE, UUID ordered
→ sessions FOR NO KEY UPDATE only for semantic/session-state mutations
→ turns FOR UPDATE, UUID ordered
→ attempts FOR UPDATE, UUID ordered
```

The cursor must precede `sessions` in every new writer. Existing SQL functions
that allocate from `sessions.last_sequence` prevent a one-release cutover, so
the migration is expand-and-contract with explicit compatibility gates.

## Rolling migration

### Phase A: expand and backfill

1. Add `session_event_cursors` with the same account/workspace/session composite
   identity and FORCE-RLS posture as `session_events`.
2. Backfill one row from every session's `last_sequence`.
3. Add a deferred constraint proof that cursor value equals the maximum durable
   event sequence and the compatibility `sessions.last_sequence` value.
4. Create cursor rows in every session-creation and fork path in the same
   transaction as the session.

No runtime writer changes in this phase.

### Phase B: dual-write through one allocator

1. Route TypeScript appenders through the cursor row.
2. Keep updating `sessions.last_sequence` in the same transaction for old
   readers and old SQL functions, but do it after event insertion.
3. Convert each SECURITY DEFINER event-producing function to lock/allocate from
   the cursor and dual-write the compatibility column.
4. Add a rollout assertion that rejects a mixed writer which advances only one
   side.

This phase does not yet remove the session-row lock, but proves the new allocator
under real traffic without changing public reads.

### Phase C: raw-lane isolation

Once every writer allocates through the cursor, raw-only worker appends stop
locking or updating `sessions`. They still lock the exact turn and attempt after
the cursor, so terminal settlement cannot race a late accepted delta. Semantic
events continue to lock `sessions` and commit state plus event atomically.

Unread and list projections read the cursor through a join or a denormalized
read model refreshed in the same transaction. They never infer order from NATS.

The activation is maintenance-classified because old API readers expose
`sessions.last_sequence` directly. The database boundary remains mixed-writer
safe: legacy SQL/event writers are rebased against the cursor, semantic batches
refresh the compatibility projection, and attempts to regress that projection
are clamped to the cursor. Accepted raw exact-attempt batches hold only a
session identity `FOR KEY SHARE`, then the cursor/turn/attempt suffix; rejected
late raw input rolls back and retries through the semantic activity gate.

### Phase D: contract

1. Move all public `lastSequence` reads to the cursor authority.
2. Remove compatibility dual-writes.
3. Drop `sessions.last_sequence` only after migration/static tests prove no SQL,
   TypeScript, trigger, or generated function references remain.
4. Update the architecture map and schema inventories in that same change.

## Admission and batching

The cursor does not justify one transaction per token. The current bounded
stream batcher remains. A batch claims exactly `N` sequences and inserts `N`
rows. Batches from competing producers serialize only at the compact cursor
row; no range is reserved outside the insertion transaction, so a crash cannot
create a hole.

Larger adaptive batches may be evaluated after cursor isolation. They must be
bounded by bytes and latency, not by model context or run length, and must flush
before semantic boundaries whose user-visible ordering matters.

## Rollout evidence

Promotion requires all of the following:

- cursor/session/max-event parity at zero mismatches;
- no duplicate `(session_id, sequence)` violations;
- event append p95 and p99 split by inner phase and whole transaction;
- raw-lane session-row lock waits materially reduced;
- unchanged NATS publish latency and SSE replay/gap tests;
- exact-attempt late-event rejection tests under concurrent terminal settlement;
- mixed-version rolling tests for every expansion phase;
- a rollback that stops new routing without deleting cursor rows or event truth.

The expected success signature is that `attempt_fence` or cursor acquisition
contains the necessary same-session serialization, while `event_insert`,
projection, cursor update, and commit remain small and unrelated sessions no
longer amplify one another through the wide `sessions` row.
