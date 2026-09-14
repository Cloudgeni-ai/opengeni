# Knowledge collection listing: PostgreSQL evidence

Measured September 14, 2026 against base `71ca29b74f271d477b38a290a2cd23baf39475d5`.

## Finding and change

The expensive path was not primarily the materialized candidate CTE. PostgreSQL's
generic plan for `knowledge_entry_visible_body` estimated each JSON array at 100
rows, hash-joined it against account entries, and ran the recursive visibility
predicate on account entries **before** matching the referenced endpoint. A list
summary invokes this full-body helper to obtain its collection IDs, repeating
that work for each returned row and for both collection and relationship arrays.

Migration 0468 replaces those two joins with scalar, exact-account/exact-ID
subqueries. Each endpoint is still checked by the unchanged
`knowledge_revision_visible`; missing/archived endpoints disappear, array order
and duplicates survive, and published-first/pending-fallback selection is unchanged.
The scalar lookup cannot return multiple rows because entry IDs are unique.

No changes were made to `knowledge_entry_read`, `knowledge_revision_visible`,
source/provider ACL functions, search ranking, current-revision selection, scope
filters, pagination, tables, indexes, or runtime grants. This is an online-compatible
function-body replacement, not a new authority or a visibility cache.

## Method

- Real local PostgreSQL 17.11, pgvector 0.8.0, JIT on, 128 MB shared buffers;
  Bun 1.3.14 (the repository pins 1.4.0).
- Entire migration ledger applied using a NOSUPERUSER/NOBYPASSRLS owner;
  measured reads used a separate NOSUPERUSER/NOBYPASSRLS application login.
  Knowledge tables remained FORCE-RLS and inaccessible to direct app reads.
- Synthetic account/workspace fixtures: 240 or 2,400 collection members, two
  immutable published revisions per member, current and historical collection
  edges, one relationship per member, and exactly one quarter of members depending
  on a retained 96,000-byte file-backed source. Member bodies contain about 1.2 KB
  of text. Other fixture accounts coexist; every fixture runs ANALYZE.
- The baseline read and projection definitions are extracted from immutable
  migration 0461 and installed under test-only names with the same function owner.
  Baseline reads call the historical projection; optimized reads call the current
  production capability. Both see the same rows, permissions, and PostgreSQL server.
- One warmup precedes measured runs. Timings include the same tenant-context
  transaction, SQL invocation, JSON transfer, and transaction commit. App connections
  use `prepare: false`, matching `createDb`. Every returned JSON object is compared
  exactly. EXPLAIN ANALYZE/BUFFERS is a separate execution after timing.
- No production database or provider was accessed or changed.

## Results: 240 members, five measured runs, limit 20 (+1 sentinel)

| Request | Baseline median | Optimized median | Baseline / optimized buffer hits |
| --- | ---: | ---: | ---: |
| Collection members | 5,343.55 ms | 184.68 ms | 4,058,830 / 19,454 |
| Flat list | 5,349.16 ms | 106.03 ms | 3,874,661 / 10,574 |
| Root-only | 142.56 ms | 141.95 ms | 16,005 / 16,005 |

The collection case is about 29x faster, with approximately 99.5% fewer buffer
hits. Flat listing is about 50x faster. Root-only is essentially unchanged because
this fixture returns the collection and source, whose endpoint arrays are empty.

An earlier diagnostic fixture without the file-backed-source check also exposed
the plan shape directly through auto_explain: 204,232 total list buffer hits,
10,654 in candidate selection, and 9,212 per full-body summary projection. Each
array's hash-join input checked all 242 account entries to emit one matching ID.
Those diagnostic figures are **not** mixed into the table's before/after comparison.

A separate EXPLAIN of the parameterized helper body under the non-superuser
owner, tenant RLS context, and `force_generic_plan` confirms the changed access
path: the historical plan has two bitmap account scans, each emitting 242 rows
after recursive visibility filtering; the new plan has two scalar-subquery index
scans on `(account_id,id)`, each emitting exactly one endpoint. This diagnostic
plan is retained separately from end-to-end capability timings.

## Results: 2,400 members, three measured runs, limit 20 (+1 sentinel)

| Request | Baseline median | Optimized median | Baseline / optimized buffer hits |
| --- | ---: | ---: | ---: |
| Collection members | 174,955.67 ms | 1,182.80 ms | 343,044,196 / 303,629 |

The three baseline samples were 175,173.08, 174,648.44, and 174,955.67 ms;
the optimized samples were 1,182.80, 1,185.32, and 1,179.31 ms. That is about
148x faster and 99.91% fewer buffer hits, with exact full-response JSON parity.
The separate EXPLAIN executions took 174,627.83 and 1,178.29 ms. Both wrote 526
temporary blocks: the unchanged materialized candidate work can still spill.
This larger comparison runs only the collection request, not the root/flat cases.

## Verification and reproduction

```sh
# Standard repository shared PostgreSQL/pgvector Docker fixture:
bun test packages/db/test/knowledge-collection-listing-postgres.test.ts
bun packages/db/test/knowledge-collection-listing.bench.ts 240 5
bun packages/db/test/knowledge-collection-listing.bench.ts 2400 3 group

# Optional pre-migrated, disposable native fixture (loopback URLs required):
export OPENGENI_KNOWLEDGE_TEST_ADMIN_URL='<local disposable test database admin URL>'
export OPENGENI_KNOWLEDGE_TEST_APP_URL='<same database, provisioned non-owner app URL>'
# Run the same commands. The native override does not drop the supplied database.
```

The new suite covers exact list/root/search/history/detail JSON parity, full-page
cursor traversal without gaps/duplicates, scope and archived collection behavior,
source revocation/restoration, unavailable relationship endpoints, denied raw
table access and forged context, human-review requirements, missing/cross-account
endpoints, duplicate IDs, array ordering, and published-first/pending-only endpoints.

Validation passed: six new PostgreSQL tests (111 assertions), all 38 existing
unified-Knowledge PostgreSQL tests (204 assertions), eight release-schema contract
tests (267 assertions), DB typecheck, and migration schema-registration,
FORCE-RLS-backfill, timeout-budget, and ordinal guards. The existing unified suite
used a temporary native adapter equivalent to its normal superuser-migrated shared
fixture, with the standard `opengeni_app` role; the new parity tests and benchmark
used the stricter owner-migrated fixture described above.

## Limits

These are synthetic warm-cache local measurements, not production telemetry or
latency guarantees. The standard harness's PostgreSQL 16 Docker variant was not
available here; PostgreSQL 17 was exercised. No external provider was contacted.
The existing source/evidence authorization functions remain authoritative and
unchanged. Dense evidence graphs, cold storage, high concurrency, and very large
endpoint arrays can have different costs. Candidate visibility still scales with
candidate count, root traversal is not accelerated, and summaries still construct
the visible body; further changes to those paths require separate measured work.