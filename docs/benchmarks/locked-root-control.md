# Reuse locked root control facts

Attempt write admission already holds the session row with `FOR NO KEY UPDATE`.
For a root session, that row is the complete ancestry, so admission can use its
five bounded control fields instead of querying the same row recursively. The
workspace control lock, revision validation, pause/override precedence, attempt
ownership, authority and interruption checks remain in place. There is no cache,
new transaction boundary, migration or change to model input.

Child sessions still read their ancestry. KEY SHARE writers still perform the
existing fresh ancestry query after the post-cursor session refresh; they do not
reuse the weaker initial lock. The compact session lock projection carries five
additional scalar fields, including on these unchanged paths.

## Local worker measurement

Exact base: `48e825df923d4ff8f77891ae0515eb6258ef0269`.
Restricted real PostgreSQL, production worker/runtime, five local SDK tool calls
and two scripted model responses. Candidate/base/base/candidate order, 16 turns
per process with the startup turn excluded: 30 measured turns per revision and
scenario. No provider, external connector, Temporal or network-delay simulation.

| Per turn | Base | Candidate |
| --- | ---: | ---: |
| Root SQL statements | 781 | 756 |
| Root transactions | 90 | 90 |
| Child SQL statements | 785 | 785 |
| Child transactions | 90 | 90 |
| Root process CPU median, pair 1 / pair 2, ms | 255.7 / 263.9 | 236.3 / 252.4 |
| Root elapsed median, pair 1 / pair 2, ms | 417.5 / 426.2 | 396.4 / 420.8 |
| Child process CPU median, pair 1 / pair 2, ms | 278.5 / 256.2 | 259.7 / 264.9 |
| Child elapsed median, pair 1 / pair 2, ms | 417.2 / 433.6 | 411.1 / 421.9 |

The root fixture eliminates 25 ancestry statements (3.2% of all statements), not
25 transactions. CPU improved in both root pairs but varied between processes;
child CPU results are mixed. This is not a whole-service CPU/memory or production
latency claim. Protocol cycles include preparation and concurrent connections,
so they are not a count of serial round trips.

Run the same harness on each revision, copying the benchmark's child-fixture
option into the base when needed:

```sh
OPENGENI_REQUIRE_REAL_DB=1 OPENGENI_BENCH_WORKER_TOOLS=5 \
  OPENGENI_BENCH_WORKER_SAMPLES=16 OPENGENI_BENCH_OUTPUT=worker-root.json \
  bun scripts/operator/bench-worker-resources.ts
OPENGENI_REQUIRE_REAL_DB=1 OPENGENI_BENCH_WORKER_TOOLS=5 \
  OPENGENI_BENCH_WORKER_CHILD=1 OPENGENI_BENCH_WORKER_SAMPLES=16 \
  OPENGENI_BENCH_OUTPUT=worker-child.json bun scripts/operator/bench-worker-resources.ts
```

Tests compare the retained recursive evaluator with the locked-root path across
pause/revision combinations and invalid revisions, exercise actual root/child
and full/compact lock paths, and verify concurrent control updates cannot change
the reused row before transaction release. The ordinary control, write-fence and
lock-order suites remain authoritative for all other behavior.
