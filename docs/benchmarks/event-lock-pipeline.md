# Ordered event-lock pipelining

`lockSessionEventWriteRows` submits workspace/session reads together and then
turn/attempt reads together on its existing transaction-pinned connection. The
database executes each statement in the canonical lock order. The cursor read,
post-cursor raw-writer refresh, and cursor validation remain dependency barriers.
There is no result cache, combined SQL snapshot, lock removal or write batching.

Run the paired real-PostgreSQL diagnostic:

```sh
OPENGENI_REQUIRE_REAL_DB=1 bun scripts/operator/bench-event-lock-pipeline.ts
```

It imports the exact previous helper from Git, uses restricted application-role
transactions against a disposable database, and compares all returned fields and
SQL statement order for both full/compact projections and both session lock modes.
Each case has five warmup pairs and 25 measured alternating pairs. Override the
baseline with `OPENGENI_BENCH_LOCK_BASE` when needed.

Observed compact semantic-fence medians on one local run:

| Fixture | Previous | Pipelined |
|---|---:|---:|
| Loopback elapsed | 3.54 ms | 3.36 ms |
| Simulated 4 ms round trip | 45.29 ms | 36.77 ms |
| SQL statements | 10 | 10 |
| Protocol response cycles | 10 | 10 |
| Approximate request waves | 10 | 8 |

The raw key-share path retains its additional post-cursor session read: 11
statements/cycles, with observed request waves reduced from 11 to 9. The synthetic
delay adds 2 ms in each direction only on the disposable fixture's relay.

This establishes two fewer sequential waits in the measured warmed driver path,
not fewer SQL statements, less database CPU, or a live service speedup. TCP request
waves are a diagnostic approximation, not a general wire-protocol RTT metric.
Cold statement description, driver implementation and contention affect results.
The helper still requires a transaction-pinned handle; supported drivers must
serialize submitted statements on that transaction's connection. A queued read
may already be in flight when application-side result decoding fails, so rollback
must wait for that read rather than assuming it was never submitted.
