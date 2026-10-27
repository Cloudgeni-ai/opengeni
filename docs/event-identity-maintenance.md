# Online historical event identity maintenance

Tool-event identity projections were added without rewriting historical event
payloads. Old rows therefore keep NULL projections and exact name/call-ID reads
must inspect their payload fallback. The operator can explicitly fill those
existing columns while the API and workers continue serving traffic.

This job is **never a startup hook, migration-time backfill, scheduled task, or
request-time write**. It does not stop/drain services, change RLS, rewrite event
payloads, alter canonical history, or replace non-NULL projections.

## Run and resume

Use an existing privileged operator connection (superuser or BYPASSRLS), not an
application connection or an ordinary owner subject to FORCE RLS. The job refuses
insufficient privilege instead of silently treating hidden rows as completion.
Store the connection in `OPENGENI_MAINTENANCE_DATABASE_URL` through your normal
secret mechanism; never put it in command-line arguments or logs.

```sh
# Bounded inspection only; no writes and no full-table counting scan.
bun scripts/operator/backfill-event-identities.ts --checkpoint /durable/event-identities.json

# Explicit application. A second invocation with the same file resumes.
bun scripts/operator/backfill-event-identities.ts --apply \
  --checkpoint /durable/event-identities.json --batch-size 500 --pause-ms 100
```

The directory must already exist on durable storage. Keep the checkpoint and
logs private; they contain internal row IDs but no event payloads. Resume against
the **same database**. The stored database-name check is not proof of server
identity. Do not replace the checkpoint with one from a different deployment.

`--max-batches N` deliberately stops after N committed batches. SIGINT/SIGTERM
finish the current bounded transaction and checkpoint before stopping. A lock
or statement timeout exits with the previous checkpoint intact: inspect the
failure and resume. Defaults are a 1-second lock wait and 10-second statement
timeout, configurable with `--lock-timeout-ms` and `--statement-timeout-ms`.
These timeouts also cover the initial inspection. Timeouts/pacing apply only to
this maintenance job, not other workloads.

The job owns one session advisory lock unrelated to application locking. Its
dedicated connection disables automatic lifetime and idle rotation, so a long
run or pacing interval does not deliberately discard that lock. Each batch still
verifies the backend identity: genuine disconnection/reconnection exits instead
of continuing after losing ownership. Resume from the checkpoint after inspecting
that failure. There is no new database role or schema object.

## Correctness and costs

The initial upper primary-key boundary and last scanned UUID are checkpointed.
Selection and ordering retain the native UUID type, so both the upper-bound read
and each frontier read use the existing primary-key index without a text sort.
Each transaction scans a bounded ID range and updates only missing projections
whose current payload resolves a value. It retains the same JSON text extraction
and alias order as the existing trigger. Missing/oversized identities are not
rejected. No `SKIP LOCKED` is used: a failed batch cannot advance past a locked
row. Checkpoints are written atomically **after commit**; a crash before the file
update repeats an idempotent batch. Concurrent normal payload writes keep using
the existing trigger, and rows inserted while the scan runs already receive
their projections normally. This is not a repair of arbitrary raw-storage writes
which bypass that trigger after the scan has passed.

The job scans the finite primary-key range, including non-tool events, to avoid
repeatedly searching millions of NULL projections. It reads payloads only for
eligible tool rows. Filling projections creates new tuple/index versions, WAL
and subsequent vacuum work. Benchmarking 10,165 updates in a disposable fixture
generated 20–37 MB of WAL depending on page-image state. This is not a live
capacity estimate. Start with paced batches, watch normal request/worker health,
database CPU and WAL, and adjust only this job's pacing. Do not disable normal
autovacuum or constrain unrelated traffic.

JSON lines report per-batch elapsed time, scanned/updated counts and WAL measured
by `EXPLAIN (ANALYZE, WAL)` on the actual UPDATE. `statementWalBytes` excludes
commit records. The end-to-start server LSN difference includes **all concurrent
traffic**, so it must not be reported as this job's exact WAL volume. An uncertain
commit followed by checkpoint loss can also repeat work and undercount its
already-emitted telemetry; preserve the logs when reconciling such a run.

Existing fallback indexes/readers remain valid before, during and after the job.
Rows with genuinely absent or oversized identities still use fallback behavior;
this job alone does not promise constant-time lookups. Index predicate changes
are a separate schema operation, not silently performed by the maintenance CLI.

## Verification

Run the operator's real-PostgreSQL suite with the repository test environment:

```sh
OPENGENI_REQUIRE_REAL_DB=1 bun test scripts/operator/backfill-event-identities.test.ts
```

It covers alias precedence, absent/oversized values, unchanged payloads and reader
responses, non-NULL preservation, repeat-after-commit behavior, checkpoint resume,
operator-role refusal, transaction failure, normal payload writer interaction,
and backend-ownership loss. No model provider calls are needed.
