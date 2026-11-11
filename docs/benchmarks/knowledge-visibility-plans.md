# Knowledge visibility statement reuse

Migration 0936 changes the existing recursive array visibility helper from SQL
to PL/pgSQL with a function-local `plan_cache_mode=force_generic_plan`. Its query
is unchanged except for three column qualifications needed to disambiguate
PL/pgSQL output variables. Existing callers, per-member parent checks, candidate
filtering, ACL helpers, ranking and pagination remain in place. No result or
authority cache is introduced.

The function-local setting also applies to nested work during the call and is
restored on return. Tests cover caller modes, security metadata, restricted-role
plans, source revocation, historical replay and exact output parity. This is
not a coherent-snapshot change: volatile checks retain their existing freshness.

## Reproduction

Use the repository's required disposable real-PostgreSQL environment, then run:

```sh
bun scripts/operator/bench-knowledge-visibility-plans.ts
OPENGENI_BENCH_PLAN_MODE=force_custom_plan bun scripts/operator/bench-knowledge-visibility-plans.ts
OPENGENI_BENCH_PLAN_MODE=force_generic_plan bun scripts/operator/bench-knowledge-visibility-plans.ts
```

The comparison clones the unchanged reader chain with the exact preceding SQL
array-helper body. Each size/shape uses three warmup pairs and 30 measured pairs,
alternating order. Every decoded response is compared, including property order.
Small fixtures precede large fixtures on the same application connection.

One local default-mode run on PostgreSQL 16:

| Members | Request | Previous median | Candidate median |
|---:|---|---:|---:|
| 0 | List | 1.808 ms | 1.482 ms |
| 0 | Roots | 2.682 ms | 1.656 ms |
| 0 | Collection | 1.436 ms | 1.033 ms |
| 1 | List | 2.543 ms | 1.794 ms |
| 1 | Roots | 3.442 ms | 1.840 ms |
| 1 | Collection | 2.649 ms | 1.585 ms |
| 240 | List | 15.932 ms | 8.358 ms |
| 240 | Roots | 91.904 ms | 14.179 ms |
| 240 | Collection | 106.014 ms | 20.415 ms |

These are synthetic elapsed times, not production latency or whole-system CPU
claims. Network round trips, response sizes and per-member check counts do not
change. Backend plan memory and performance at other graph sizes require
separate measurement; there is no universal plan guarantee.

## Rejected alternatives and regression coverage

Batching parent visibility once per listing changed an actual concurrent
revocation result from one member to eight, and made sparse/missing collections
materialize unrelated candidates. That version was rejected. The retained
regression gates execution after a helper result, revokes the parent's backing
file, and confirms both implementations return one member followed by an empty
subsequent read. Restricted-role sparse/missing tests compare actual custom and
generic nested plans against the previous reader's buffer work.

A plain PL/pgSQL conversion without scoped generic planning also failed mixed
cardinality benchmarking: after small requests, a 240-member ordinary listing
rose from 14.450 to 28.611 ms, and collection reads barely improved. The scoped
setting is therefore part of the design, not an optional benchmark adjustment.
