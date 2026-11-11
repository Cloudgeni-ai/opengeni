# Routine ACL expansion during readiness

The readiness inspector expands each routine's ACL to determine whether PUBLIC
has EXECUTE. Many routines have identical ACLs and owners. A lateral join with
`LIMIT 1` keeps the existing boolean and snapshot semantics while allowing
PostgreSQL to memoize identical `(proacl, proowner)` inputs within the statement.
No result survives the query; each readiness call still performs all live checks.

The main routine inventory and subscription-owner inventory use the same shape.
The query returns one row per routine even when no PUBLIC grant exists. Default
ACLs, empty ACLs, signatures, sorting and the other posture fields are unchanged.

## Controlled evidence

Base: `3640265fe8926cea161cc70a085f99338d2ef96e`. PostgreSQL 16.15,
restricted application role, disposable fully migrated database. The inventory
contained 541 target tables, 106 private tables and 1,544 target/private routines.

An alternating SQL-only diagnostic, with JIT disabled and four warm-up rounds
followed by 20 measured rounds per shape, returned identical complete row arrays:

| Routine inventory | Original | Lateral ACL |
| --- | ---: | ---: |
| Median execution | 4.903 ms | 4.389 ms |
| ACL expansion executions | 1,544 | 6 |

The candidate plan had 1,538 memoization hits and six misses, no evictions or
overflows, and 1 KiB peak memoization memory. The planner may choose differently
for another catalog or when memoization is disabled; correctness does not depend
on that optimization.

The complete inspector benchmark alternates execution order on one connection,
excludes two warm-up pairs, and compares all posture fields. Ten measured calls
per revision, with JIT disabled:

| Complete readiness inspection | Original | Candidate |
| --- | ---: | ---: |
| Median elapsed | 18.674 ms | 18.587 ms |
| Median client process CPU | 6.833 ms | 6.191 ms |
| SQL statements | 13 | 13 |
| Protocol cycles | 13 | 13 |
| Response bytes | 376,766 | 376,766 |

This does **not** establish a meaningful whole-readiness latency improvement,
nor a whole-service CPU or memory reduction. A default-fixture run used JIT and
reported 30.869 → 27.909 ms, but compilation contributed to that difference; do
not apply that ratio to a non-JIT production plan.

Reproduce the full inspector comparison from the repository root:

```sh
OPENGENI_TEST_PG_URL=postgres://postgres:x@127.0.0.1:61440/postgres \
OPENGENI_REQUIRE_REAL_DB=1 \
OPENGENI_BENCH_POSTURE_JIT=off \
OPENGENI_BENCH_POSTURE_BASELINE=3640265fe8926cea161cc70a085f99338d2ef96e \
bun scripts/operator/bench-runtime-posture.ts
```

Only the benchmark connection receives the optional JIT setting. No deployment
configuration, readiness cadence, grants, migrations or public API changes.

## Correctness boundary

Do not substitute `has_function_privilege('public', ...)`: it consults current
privilege metadata and can observe a concurrent GRANT/REVOKE that the inspector's
repeatable-read catalog snapshot cannot yet see. The lateral query instead uses
the same `pg_proc` tuple and `aclexplode` inputs as the original expression.

`runtime-posture-public-acl-postgres.test.ts` compares the actual emitted queries
against the prior correlated expression in custom/generic plan modes and with
memoization enabled/disabled. It covers null/default and empty ACLs, PUBLIC versus
runtime/owner grants, grant options, overloads, procedures, both routine queries,
concurrent grant/revoke snapshot stability and refresh on the next inspection.
The existing posture and previous-binary compatibility suites remain required.
