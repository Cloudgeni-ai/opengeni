# Recovery history artifacts

This document is the current operator and maintainer contract for precomputing,
persisting, and admitting an exact recovery-session history artifact. The
canonical implementation is
[`packages/db/src/recovery-artifacts.ts`](../packages/db/src/recovery-artifacts.ts);
the database fence is migration
[`0095_recovery_artifact_fence.sql`](../packages/db/drizzle/0095_recovery_artifact_fence.sql).

## Safety contract

A recovery artifact is admitted only at a linearization point where its
workspace-control revision and its complete `(session_id, revision)` set still
match durable truth.

The operation has three deliberately separate phases:

1. `precomputeRecoveryArtifact` uses a read-only, repeatable-read transaction.
   It pages the materialized session tree and events in canonical UUID/sequence
   order, pins timestamp rendering to UTC, hashes full rows, and discards event
   pages as it proceeds. It takes no workspace, session, control, event, or
   recovery-barrier row lock.
2. `persistRecoveryArtifact` validates and inserts immutable,
   content-addressed artifact truth. A repeated insert of the same hash must
   match the stored metadata and canonical manifest exactly. This phase also
   precedes admission locking.
3. `admitRecoveryArtifact` asks the database-owned
   `opengeni_private.admit_recovery_history_artifact` function to load and index
   the persisted manifest before requesting the workspace barrier `FOR UPDATE`.
   While holding that barrier it checks the idempotency key, exact workspace
   control revision, and both directions of the expected/current session
   revision-set difference, then inserts at most one append-only admission.

Recovery-relevant writers take a compatible `FOR KEY SHARE` barrier in
statement-level triggers and advance the affected session revisions. Session
creation materializes the immutable tree root; session deletion and workspace
control mutation also participate in the barrier. The covered mutable truth
includes sessions, events, conversation history, turns and attempts,
interruptions, pending tools, goals and workflow wakes, system updates and
outboxes, run state, sandbox envelopes, capacity waiters, session MCP servers,
composer drafts, and command receipts. Adding recovery-relevant mutable truth
requires extending migration-owned trigger coverage in a new forward migration.

Concurrent writers either commit before final validation and make the artifact
return a typed retry, or linearize after the admission and invalidate later
reuse. A stale revision set is never admitted. Workspace deletion cannot invert
the barrier lock because an admission's only foreign-key dependency is the
barrier row already held by the function.

The only non-error stale results are:

- `workspace_control_changed`
- `session_tree_changed`

The caller must discard the stale artifact and restart precompute. Reusing an
idempotency key for different canonical input raises
`RecoveryAdmissionConflictError`; it is not a retry. Artifacts and admissions
are immutable except for parent-workspace cascading deletion.

## Retry and effect boundary

Precompute may be restarted after failure or process death because it has no
effects. Artifact persistence and final admission may use the canonical
persistence-only SQLSTATE retry seam for serialization failures, deadlocks, or
other classified transient database failures.

That retry wrapper must contain **only** artifact persistence/admission. Model
inference, tools, sandbox calls, provider work, event publication, workflow
signals, and other external effects must occur only after one committed
admission and must never be inside the retried closure. The persistence API has
no effect callback by design. A transaction rollback leaves no admission, and
an exact retry uses the same idempotency key to return the original admission
without replaying effects.

Temporal `continueAsNew`, workflow retry, process death, or a new worker does
not weaken this rule: reconstruct or reload the immutable artifact, run the
same final fence, and begin effects only from the committed admission result.

## Tenant and privilege boundary

All four recovery tables carry `account_id` and `workspace_id`, enable and
force RLS, and use the normal `workspace_isolation` policy. Runtime calls must
use the non-superuser application role and set both RLS GUCs on the active
transaction. The admission function rejects a mismatched RLS context even
though it is `SECURITY DEFINER`.

The application role cannot mutate barrier/revision truth or insert an
admission directly. The security-definer function is the sole runtime insert
path, and an owner-only trigger protects against future broad grants. Do not
operate this surface with a superuser or bypass-RLS role outside migration and
explicit disaster-recovery procedures.

## Observability

The library accepts the structural `RecoveryArtifactObservability` port. Metric
and span dimensions are intentionally fixed-cardinality: they never include
workspace/session/account IDs, artifact hashes, idempotency keys, titles, event
payloads, prompts, or credentials.

| Metric | Labels | Meaning |
| --- | --- | --- |
| `opengeni_recovery_artifact_precompute_duration_seconds` | `outcome=success|error` | Time spent in the lock-free precompute phase. |
| `opengeni_recovery_artifact_rows` | `phase=precompute`, `kind=sessions|events` | Rows hashed into a successful artifact. |
| `opengeni_recovery_artifact_canonical_bytes` | `phase=precompute` | Canonical bytes hashed. |
| `opengeni_recovery_artifact_final_lock_wait_seconds` | `outcome=admitted|reused|stale|error` | Database-reported wait for the final workspace barrier. |
| `opengeni_recovery_artifact_final_lock_hold_seconds` | `outcome=admitted|reused|stale|error` | Database-reported final critical-section duration. |
| `opengeni_recovery_artifact_stale_rejections_total` | `reason=workspace_control_changed|session_tree_changed` | Exact revision-fence rejections. |
| `opengeni_recovery_artifact_persistence_retries_total` | `phase=persist|admit`, `reason=serialization|deadlock|transient` | Persistence-only retries; never effect retries. |

Spans are `db.recovery_artifact.precompute` and
`db.recovery_artifact.final_admission`. They carry only format version,
outcome, and successful aggregate row/byte counts.

Recommended dashboards compare precompute duration and bytes by quantile,
final-lock wait versus hold time, stale rejections versus admission attempts,
and persistence retries by phase/reason. Investigate a sustained rise in stale
ratio, any deadlock retry, or final-lock hold time approaching the benchmark's
2-second release ceiling. Page on database lock timeouts or a canary fence that
admits deliberately stale input; do not weaken the fence to reduce retries.

## Production canary

Use a dedicated canary workspace created through the normal product path. Do
not use a customer recovery tree or issue ad hoc privileged SQL.

1. Confirm migration 0076 completed on every database before enabling a caller.
   Keep the recovery caller disabled during a mixed-schema rollout.
2. Record baseline database lock waits, writer throughput, and the metrics
   above. Confirm the caller uses the application role and RLS wrapper.
3. Precompute and persist one small canary tree. Admit it with one stable,
   opaque idempotency key. Repeat the exact admission and require
   `kind=admitted, reused=true` with the same admission ID and no effect replay.
4. Precompute another artifact, mutate the canary through one normal event or
   control path, and then attempt admission. Require the appropriate typed
   stale result and zero external effects. Precompute current truth and admit
   it with a new idempotency key.
5. Run concurrent normal title/event/child/control traffic in that canary and
   unrelated workspace traffic. Verify unrelated operations are not serialized
   and inspect `pg_stat_activity` for waits on the dedicated recovery barrier,
   not workspace/session/event rows.
6. Expand gradually while watching final-lock wait/hold, stale ratio,
   persistence retries, database CPU/temp-file pressure, and application
   latency. Stop expansion if the release thresholds or deployment SLOs are
   exceeded.

The canary is successful only if exact retries reuse one admission, stale input
is rejected, no model/tool/provider work replays, and unrelated throughput
remains within the deployment's normal variance.

## Stress receipt and release thresholds

Run the real-PostgreSQL benchmark after the code is checkpointed. It accepts
only 1,000, 4,000, or 10,000 sessions, seeds one event per session, measures two
precomputes plus persistence/admission, and recomputes the checksum in an
independent Bun process:

```bash
bun scripts/bench-recovery-artifacts.ts --sessions 1000 --output /tmp/recovery-artifacts-1000.json
bun scripts/bench-recovery-artifacts.ts --sessions 4000 --output /tmp/recovery-artifacts-4000.json
bun scripts/bench-recovery-artifacts.ts --sessions 10000 --output /tmp/recovery-artifacts-10000.json
```

With external PostgreSQL, set `OPENGENI_TEST_DATABASE_ADMIN_URL` and
`OPENGENI_TEST_DATABASE_URL`; otherwise the benchmark uses disposable test
services. Never put URLs or credentials in the receipt or commit local receipt
files.

Default per-run ceilings are 180 seconds to seed, 60 seconds per precompute, 10
seconds for admission wall time, 2 seconds for final barrier hold, 768 MiB RSS
growth, and 512 MiB heap growth. They can be tightened for a known production
tier with the `OPENGENI_RECOVERY_BENCH_*` environment variables. Every receipt
must also report identical hashes and aggregates across both in-process retries
and the independent process.

## Disable and rollback

This is a forward-only rolling migration. To stop a canary or roll back caller
code, disable the recovery caller/control surface first and wait for in-flight
admissions to settle. Leaving migration 0076 in place is safe: without callers,
no new artifact/admission work occurs, while compatible writer barriers keep
revision truth current.

Do not delete immutable rows, downgrade the migration, drop triggers, or disable
revision fencing while any caller can admit artifacts. A schema rollback or
trigger-coverage change requires a separately reviewed forward migration. If an
incident is caused by the caller, roll back only the application integration;
if the database fence itself is implicated, keep recovery admission disabled
and follow the database incident process rather than bypassing exactness or RLS.