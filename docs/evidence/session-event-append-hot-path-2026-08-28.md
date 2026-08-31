# Session-event append hot-path evidence — 2026-08-28

This note preserves the first source-bound, production-posture local evidence for
the session-event append hot path. It is benchmark evidence, not a staging result
and not proof that the proposed architecture has reached its latency target.

## Sources under test

- Baseline benchmark source:
  `660e2e882a42746ccd881d9b4d4fa3ddb1227740`
- Local integration source:
  `189620631f2313e8c47ef0f2975061fb227bc190`
- The integration source is the baseline plus the changes proposed independently
  by #1961 (`perf(db): narrow session event write admission`) and #1964
  (`perf(db): collapse base RLS context setup`). It is a measurement stack, not a
  merge candidate.

The design's normal accepted-batch lower bound is 19 explicit SQL statements for
a raw batch and 27 for a semantic batch, excluding transaction control, optional
projection work, and trigger-internal SQL. #1961 removes two discarded
control-read queries from the append fence. #1964 combines four base RLS setup
queries into one. The integrated lower-bound projection is therefore 14 raw and
22 semantic statements. Neither change weakens the canonical workspace-control
lock prefix, exact turn/attempt admission, per-session sequence allocation,
FORCE RLS, activity truth, existing transactional outboxes, or rejected-late
audit handling.

## Fixture posture

Both receipts were collected on the same warm, disposable local fixture with:

- Bun 1.4.0 on Linux x64;
- PostgreSQL 17.11 and pgvector 0.8.6;
- `fsync=on`, `synchronous_commit=on`, and `full_page_writes=on`;
- the non-superuser, non-`BYPASSRLS` `opengeni_app` role;
- FORCE RLS enabled on both `sessions` and `session_events`;
- a successful cross-tenant isolation probe; and
- 200 samples per scenario, batch size 1, at concurrency 1 and 8.

The full receipts are committed beside this note:

- `session-event-append-focused-baseline-660e2e882.json`
  (`sha256:5a17eac23b0c3680a1c6edc7fd403d36f9efbb1988564210a534e21c9a5e3dea`)
- `session-event-append-focused-combined-189620631f231.json`
  (`sha256:6c578ae0be7274f5fcb0e3bccf0bdaa0a7dc187d587162b5680e35a1d7f8bbcf`)

An earlier local integration output carried a mistyped caller-supplied source
SHA and was discarded. Only the rerun carrying the verified full Git object id
is committed here.

## Paired result

| Scenario | Baseline p50 ms | Integrated p50 ms | Baseline p95 ms | Integrated p95 ms | Baseline ops/s | Integrated ops/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Same session, raw, c1 | 15.626 | 11.948 | 18.095 | 15.231 | 63.387 | 82.133 |
| Same workspace, raw, c1 | 15.670 | 11.606 | 18.859 | 14.227 | 62.935 | 84.619 |
| Multi-workspace, raw, c1 | 14.973 | 11.501 | 17.455 | 13.354 | 65.897 | 86.301 |
| Same workspace, raw, c8 | 28.210 | 25.985 | 39.899 | 36.142 | 251.972 | 278.345 |
| Multi-workspace, raw, c8 | 27.922 | 23.708 | 33.144 | 28.899 | 278.455 | 322.303 |
| Same session, semantic, c1 | 20.433 | 17.452 | 23.447 | 20.503 | 48.376 | 57.194 |
| Same workspace, semantic, c1 | 19.726 | 15.729 | 24.579 | 19.642 | 49.886 | 61.690 |
| Multi-workspace, semantic, c1 | 19.908 | 16.106 | 23.633 | 19.245 | 49.541 | 61.238 |
| Same workspace, semantic, c8 | 43.382 | 36.255 | 53.562 | 44.644 | 155.693 | 183.347 |
| Multi-workspace, semantic, c8 | 39.805 | 29.979 | 49.956 | 34.862 | 181.217 | 239.505 |

Across all ten paired scenarios, the median changes are:

- p50: -19.68%;
- p95: -17.61%; and
- throughput: +23.64%.

For semantic scenarios alone, the median changes are:

- p50: -19.10%;
- p95: -18.57%; and
- throughput: +23.61%.

The strongest semantic result is multi-workspace concurrency 8: p95 improves
30.21% and throughput improves 32.16%. Every paired p95 improves, with reductions
from 9.42% to 30.21%; the wider 42-scenario runs still showed substantial local
host variance, so these values are evidence for direction and query cost rather
than a production capacity claim.

## Invariants and unresolved scaling

Both receipts report:

- 16 durable session rows;
- zero sequence-gap sessions;
- zero duplicate-sequence sessions;
- zero ordinary appends transformed into rejected-late events; and
- zero missing session rows.

The configured 0.90 concurrency-scaling gate remains unmet. Baseline efficiency
ranges from 0.390 to 0.528; the integrated stack ranges from 0.372 to 0.489.
The five-query reduction therefore produces a useful but not dramatic latency
improvement and does not remove the concurrency bottleneck.

## Architectural conclusion

This local durable append path completes at roughly 13–54 ms p95 across the
focused paired scenarios. A staging p95 near five seconds cannot be attributed to an
unavoidable PostgreSQL durability floor in this append alone. The remaining
multi-second envelope must be isolated with staging phase, pool-wait, lock-wait,
transaction, and route telemetry.

The evidence strengthens, rather than replaces, the proposed v2 architecture:

1. keep one transactional per-session sequence owner;
2. retain exact idempotency and late-attempt audit truth;
3. preserve FORCE RLS and the canonical workspace-control lock order;
4. move generalized projection work out of the sequence critical section;
5. add a durable fanout outbox without replacing PostgreSQL as audit truth; and
6. isolate append traffic in a bounded connection lane so unrelated pool
   saturation cannot turn a tens-of-milliseconds database operation into a
   multi-second request.

No staging latency, production capacity, outbox cutover, or dramatic p95 claim
is made by these receipts.