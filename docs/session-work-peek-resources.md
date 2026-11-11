# Session-work observer projections

`peekSessionWork` is an advisory control observation. Its session, cursor, active
turn and active attempt reads select only the fields consumed by its decisions.
The session and turn still come from separate fresh reads in their original
order. Workspace control, scope, RLS, cursor checks, interruption precedence,
recovery and wait handling are unchanged. No state or authorization is cached.
Turn metadata remains in the projection because recovery decisions consume it.

The observer does not return the selected database rows. Its public result and
the later worker claim/revalidation path are unchanged; frozen prompts, schemas,
configuration and canonical model history are not modified.

## Reproduce

With a disposable PostgreSQL fixture configured, run:

```sh
OPENGENI_REQUIRE_REAL_DB=1 bun scripts/operator/bench-session-work-peek.ts
bun test packages/db/test/session-work-peek-projection.test.ts
```

The benchmark loads the exact prior `index.ts` Git object, with unchanged shared
imports. `OPENGENI_BENCH_PEEK_BASE` can explicitly select another compatible base.
It creates ordinary sessions and claims through application APIs, compares the
complete observer result for every pair, and counts PostgreSQL response bytes
and protocol cycles. Each case has five warmup pairs and 30 alternating measured
pairs. The wide fixture uses a 64 KiB initial message and session metadata value,
plus a 64 KiB accepted prompt for the owned-attempt case.

Representative local results against `fa00bb255e4`:

| Case | Response bytes, old → narrow | Median elapsed ms, old → narrow |
| --- | ---: | ---: |
| Small idle session | 5,595 → 981 | 3.37 → 3.18 |
| Small owned attempt | 7,213 → 1,555 | 3.38 → 2.98 |
| Wide idle session | 136,603 → 981 | 3.56 → 3.01 |
| Wide owned attempt | 203,725 → 1,555 | 3.64 → 2.88 |

All four cases retain **14 statements and 14 protocol cycles**. These are local
measurements, not live latency, TCP-packet counts, loaded-service memory or a
whole-system improvement. The selected turn metadata can still be large; this
does not make every observation constant-size. Concurrent behavior remains the
existing READ COMMITTED behavior rather than a new coherent snapshot.
