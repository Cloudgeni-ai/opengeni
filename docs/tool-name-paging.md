# Exact tool-name and call-ID event paging

`packages/db/src/session-event-slices.ts` keeps the existing workspace/session
filters, prompt visibility, event types, call identity, direction and keyset.
For ordinary losslessly representable tool names, its metadata query merges two
disjoint ordered branches with `UNION ALL`, then applies the outer order/limit.
Each branch reads at most the requested limit plus one matching identity.
There is no cache, additional transaction, payload rewrite or authority change.
Scalar hydration and the lossless-name bypass remain unchanged.

Migrations 0943 and 0944 add concurrent partial indexes:

- `(workspace_id, session_id, tool_name, sequence)` for created calls with a
  non-null name of at most 2048 bytes.
- `(workspace_id, session_id, sequence)` for created calls with a NULL or
  larger name, retaining `coalesce(tool_name,payload->>'name')` equality.

The byte bound is solely an index-entry bound. Names are not rejected, truncated
or globally filtered. Both branches use the original database collation. A
short name can equal an oversized spelling under a nondeterministic collation;
therefore even short searches must inspect the oversized fallback.

This is an additive rolling change: older binaries continue using the original
predicate. There is no backfill and no old index is removed. The migration runner
builds each index independently and retries an interrupted invalid build. Its
historical `lock-timeout=5s` header does not bound a concurrent build's snapshot
wait. Storage and insert/update maintenance increase for created-call rows.

The fallback still scans matching session/keyset fallback candidates, potentially
all of them for an absent name. This is not constant-time lookup or a universal
planner guarantee. An all-legacy history receives no promised speedup.

## Exact call IDs

Migrations 0963 and 0964 add the corresponding call-ID indexes for created/output
tool events: `(workspace_id, session_id, tool_call_id, sequence)` for non-NULL
projections of at most 2048 bytes, and `(workspace_id, session_id, sequence)` for
NULL/oversized fallbacks. The reader uses these branches only for ordinary IDs
and an explicit nonempty type selection containing solely those two event types.
Other type selections keep the existing coalesce predicate. A simultaneous tool
name filter keeps the existing name-index path with its call-ID filter.

ID equality retains `coalesce(tool_call_id,payload->>'callId',payload->>'call_id',
payload->>'id')`, including historical NULLs, oversized and collation-equivalent
spellings. The branch limit plus outer limit preserves the global ordered page.
Neither projection is authorization; scope, RLS, prompt visibility and scalar
hydration are unchanged. No backfill, old-index removal or payload rewrite occurs.
As with name indexes, concurrent builds can wait for old snapshots beyond five
seconds. New indexes add storage and maintenance to tool-event writes.

Pre-implementation diagnostics on 12,000 local events plus 24,000 foreign-tenant
events sharing an ID measured generic-plan rare lookup buffers at 25,679 before
versus 1,240 with scoped projected/fallback branches. An expression-only hash
index was not used by the unchanged application-role query. A projection hash
index worked, but its work depended on other tenants' ID density; the scoped
B-tree was chosen to keep that lookup local. These are synthetic proposal-query
observations, not production or complete-reader timings.

Fresh scoped indexes occupied 2,433,024 and 57,344 bytes in that fixture. Twenty
measured 1,000-row rollback insert samples per sequential phase, with identity
and cursor triggers retained, had medians 129.45 versus 150.08 ms. This is about
20.6 microseconds extra per inserted row in that fixture, not a universal or
live write-cost forecast. Rollback churn was vacuumed only in the disposable
database between read-plan phases. Legacy fallback scanning remains unbounded
within the requested session/keyset range.

Run `bun test packages/db/test/tool-call-event-pages.test.ts` for generated-query,
restricted-role plan, migration, scope, paging and collation checks. Set
`OPENGENI_BENCH_TOOL_CALL_PAGES=1` to print the fixture's actual plan observations.
The existing exact-base full-reader benchmark also accepts a `callId` mode:
`bun scripts/operator/bench-tool-name-pages.ts <exact-base-commit> callId`.
It alternates baseline/candidate reads, checks complete serialized pages including
arguments and output, and keeps the original tool-name benchmark as its default.

Against exact base `8643df9f0`, all 420 alternating full-page pairs matched
(five warmup and 30 measured pairs in each of 12 cases). For 12,000 events,
projected-ID matching pages measured 49.74 → 7.52 ms; with 5% legacy projections,
51.64 → 10.01 ms. Absent IDs measured 47.60 → 4.03 and 45.76 → 5.38 ms,
respectively. Empty and one-event histories were slower by approximately
0.95–2.01 ms: the extra branch has a real fixed cost. These are local full-reader
medians on one migrated fixture, not live latency, server CPU or memory savings.

## Verification

With the repository's disposable real-PostgreSQL environment:

```sh
bun test packages/db/test/tool-name-event-pages.test.ts
bun test packages/db/test/session-event-slices.test.ts
OPENGENI_BENCH_TOOL_NAME_PAGES=1 bun test packages/db/test/tool-name-event-pages.test.ts
bun scripts/operator/bench-tool-name-pages.ts <exact-base-commit>
bun scripts/operator/bench-tool-name-index-cost.ts
```

The first suite captures the actual generated metadata SQL and checks restricted
application-role custom/generic prepared plans, result parity before/after index
builds, forward/backward/bounded paging, missing/oversized names, call identity,
idempotent valid/ready migration completion and nondeterministic ICU equality.
The optional output is fixture plan timing/buffer evidence, not live latency.
Existing slice tests retain codec, payload, legacy cursor and TOAST controls.

The full-reader benchmark loads the exact base reader from Git and alternates
30 warmed samples of each variant against the same migrated disposable database;
every complete returned page must match. It does not invoke models. The index
cost benchmark uses temporary copies with existing indexes but no triggers or
foreign keys, so its write timing isolates index overhead, not full append cost.

## Local observations

On a 12,000-call fixture against base `41bff651a`, complete matching pages took
24.65 → 2.64 ms with projected names, or 24.85 → 3.78 ms with 5% legacy rows.
Absent-name pages took 22.44 → 1.10 ms and 22.98 → 2.25 ms respectively.
This is local evidence, not measured production improvement. Small histories
pay for the second branch: a one-call match took 1.02 → 1.30 ms in the mixed
fixture. The query count is unchanged; database scan work is the target.

The temporary-table index-only probe used 20,000 rows (4,000 created calls):
417,792 bytes for the named index and 8,192 for its empty fallback index. Thirty
alternating 100-row insertion samples measured created calls at 0.994 → 1.115 ms,
outputs at 0.897 → 0.897 ms, and message deltas at 0.884 → 0.892 ms. Those are
noisy local medians excluding production triggers, foreign keys and WAL costs;
they do not establish full append latency or a fleet-level resource reduction.
