# Keyed Knowledge dependency visibility

Measured October 21, 2026 against the parent of migration 0878.

## Root cause and change

The recursive visibility function normally walks one or a few exact entry/revision
identities. PostgreSQL's recursive generic-plan estimates can instead choose hash
joins and account-wide scans of entries, evidence links, or publication decisions
for each visibility call. A list then repeats those scans for its candidates and
discovery endpoints. This is separate from the endpoint-array projection fixed by
0468.

0878 keeps the same function and all predicates, but uses parameterized LATERAL
lookups with OFFSET 0 to prevent flattening those exact-identity reads into
account-wide joins. UNION still deduplicates evidence cycles. Source/provider ACL
calls, scope checks, historical publication checks, actor validation, ranking,
pagination, projection, grants and function volatility are unchanged. No new
indexes, caches, runtime settings or public capabilities are added.

## Controlled local results

Real PostgreSQL/pgvector, application-role reads, complete migrated schema, forced
generic plans, one warmup followed by alternating before/after measurements.
The existing collection fixture supplies two revisions per member, one shared
collection, relationships to a retained 96 KB file source, and file-source evidence
for one quarter of members. Every full JSON response is compared exactly. Baseline
read and projection definitions are the current ones, with only recursive
visibility restored to its historical implementation under test-only names.

Medians in milliseconds, limit 20 plus one pagination sentinel:

| Members | Request | Before | After |
| ---: | --- | ---: | ---: |
| 240 | Flat | 92.69 | 54.15 |
| 240 | Root-only | 133.23 | 61.96 |
| 240 | Collection | 160.98 | 81.27 |
| 1,200 | Flat | 563.73 | 199.66 |
| 1,200 | Root-only | 1,338.60 | 304.73 |
| 1,200 | Collection | 1,393.24 | 336.87 |
| 2,400 | Flat | 431.48 | 412.56 |
| 2,400 | Root-only | 2,135.85 | 626.79 |
| 2,400 | Collection | 2,219.72 | 676.43 |

The 240-member fixture uses five measured runs; larger fixtures use three. Plans
change with fixture cardinality, so timings are not monotonic across sizes and
those cross-size differences are not a controlled comparison. The 2,400-member
flat query already chooses better historical access paths and gains only about
4%; do not present the larger root/collection gains as universal.

The generic-plan regression examines two entries, two evidence-link rows and four
revision rows for a two-identity dependency graph, rather than scanning the account.
Assertions count both returned and filter-rejected relation rows and allow either
valid revision index choice. These plan bounds, not wall-clock thresholds, gate CI.

## Verification

The dedicated regression covers exact current output under custom and generic
plans, keyword/hybrid search, detail/history, created-since filtering, complete
cursor traversal, evidence cycles, source revocation/restoration, archived and
private dependencies, unpublished evidence versus reviewer visibility, execute-only
access, and embedded-schema lookup hardening. Existing collection, unified
Knowledge, created-since and indexing-status suites also pass.

```sh
OPENGENI_REQUIRE_REAL_DB=1 bun test packages/db/test/migration-0878-keyed-knowledge-visibility.test.ts
OPENGENI_REQUIRE_REAL_DB=1 bun packages/db/test/knowledge-visibility.bench.ts 240 5
OPENGENI_REQUIRE_REAL_DB=1 bun packages/db/test/knowledge-visibility.bench.ts 1200 3
OPENGENI_REQUIRE_REAL_DB=1 bun packages/db/test/knowledge-visibility.bench.ts 2400 3
```

The standard disposable shared database harness is used; its existing loopback
PostgreSQL override is supported. These are warm local measurements, not production
latency or whole-system resource claims. Large/deep evidence graphs still require
work proportional to their actual reachable dependencies. Nominal reads can invoke
internal file-ACL capability writes; EXPLAIN ANALYZE of these functions is therefore
not a read-only production diagnostic.
