# Knowledge collection-ID projection

Measured against base `4fc366126dd5a3bd36a204f9b4c5c2731fcf4570` using real
PostgreSQL and the complete migration ledger. Migration 0914 only changes the
input of the summary's existing `knowledge_entry_visible_body` call: retain
`groupIds`, omit content and unused relationships. Full entry projection is
unchanged. Missing group fields become the same empty array as before; explicit
JSON null is not converted into an empty array.

## Reproduction

```sh
OPENGENI_REQUIRE_REAL_DB=1 bun scripts/operator/bench-knowledge-group-projection.ts
```

The shared fixture creates a disposable database and restricted application
role. Each comparison uses the same records and caller. Test-only copies of the
current function preserve owner, grants, hardened search path and volatility;
the baseline reverses only 0914's expression. There are five warmups and twenty
measured samples per variant, alternating order. Every complete decoded response
is checked for exact equality. Timing includes tenant setup, query, result
transfer and commit. No production traffic or provider is involved.

Each fixture has 80 collection members with two published revisions, one
collection and one retained source. Every member has one collection link and
one discovery relationship; one quarter also has an evidence dependency on the
source. The larger-body fixture appends a third revision with 128 KiB content
and copies its links. Collection requests return 20 rows plus the sentinel.

| Member content | Request | Previous median | Narrow median |
| --- | --- | ---: | ---: |
| About 1.2 KB | Collection list | 50.117 ms | 40.344 ms |
| About 1.2 KB | Full entry | 3.487 ms | 3.001 ms |
| 128 KiB | Collection list | 52.395 ms | 42.130 ms |
| 128 KiB | Full entry | 3.945 ms | 3.567 ms |

Collection lists are about 20% faster in this fixture. Full-entry gains are
smaller because the full body and relationship projection still runs. These are
synthetic local observations, not a claim about production endpoint latency,
SQL time per second, or overall platform resource reduction.

## Verification boundaries

The regression suite compares current and immediately preceding responses for
search modes, details, history, revision selection, pagination, hidden scopes,
archived/revoked collections, and source revocation. It checks duplicate/order
preservation, pending fallback, missing fields, cross-account references, and
embedded-schema function metadata. Existing visibility suites cover evidence
cycles, accepted-agent locks, and revocations between statements.

No new ACL implementation, helper, cache, index, table, write trigger or lock
policy is introduced. The function remains VOLATILE; no single-snapshot promise
is added. Invalid raw-storage relationship values may no longer fail a summary
that never uses relationships; full entry reads still inspect them. Canonical
writers validate the Knowledge body before storing it.
