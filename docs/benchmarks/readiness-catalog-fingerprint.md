# Readiness catalog fingerprint

API and worker readiness probes run the runtime database posture inspection
every few seconds. Most of its cost is eight catalog queries (table privileges
and RLS, routine privileges and dependents, role relationships, schemas,
owned schemas and relations, subscription-owner routines). Their answer
changes only when the catalogs change.

Each readiness check now keeps the catalog part of its latest inspection
together with a fingerprint of the catalog rows it was read from. Every probe
still opens the same repeatable-read, read-only transaction and reads, live,
the identity and activation predicates, the retired subscription objects, the
cutover receipts and the fingerprint. It re-runs the catalog queries only when
the fingerprint differs from the cached one, and evaluates the full posture
either way.

The fingerprint covers every non-temporary relation, every type outside
temporary schemas, every namespace, routine, policy, trigger and inheritance
row, every column with an ACL, every dependency on a routine, every role
membership and every role (through `pg_roles`), plus the current role,
`row_security` and `search_path`. Per catalog it combines the row count with a
sum of hashes of each row's identity and `xmin`, so an inserted, deleted or
updated row changes it. Privilege helpers may observe a change newer than the
snapshot; that change is then in the next probe's snapshot and changes its
fingerprint, so the catalogs are read again. Changes outside what the
inspection reads (another application's tables in a shared database) only
cause a re-read, never a stale answer. The release-gate assertion
(`db:assert-runtime-posture`) and the startup check do not use the cache.

Tests in `packages/db/test/runtime-posture-catalog-cache-postgres.test.ts`
check that each kind of change the posture depends on (table and column
grants, RLS, policies, routine grants and owners, routine dependents,
inheritance, role membership, role rename, schema grants, type rename, the
`row_security` setting, relations given to the runtime role or moved into the
data schema) is seen by the next probe, and that every cached answer equals a
fresh inspection.

## Measurements

`scripts/operator/bench-runtime-posture-readiness.ts` provisions the
production posture (non-superuser migration owner, dedicated data schema,
restricted runtime role) on local PostgreSQL 17, warms the check with five
probes and then runs readiness probes through `runtimeDatabaseReadyCheck`,
reading server time, statements and shared blocks for the runtime role from
`pg_stat_statements`. The same script ran unchanged on both revisions.

| Per probe | Before | After |
| --- | ---: | ---: |
| Statements | 12 | 5 |
| Server time, Opengeni-only catalog (4,261 relations) | 23.6 ms | 9.3–10.7 ms |
| Shared blocks, Opengeni-only catalog | 3,900 | 2,232–2,291 |
| Server time, plus 2,000 unrelated tables (14,261 relations) | 49.0 ms | 23.8 ms |
| Shared blocks, plus 2,000 unrelated tables | 6,391 | 4,005 |

After the change the fingerprint is the costliest statement of a probe
(about 8 ms on the Opengeni-only catalog). On a production catalog of similar
size it took 8–14 ms and stayed unchanged across probes over a minute, while
the table and routine posture queries it replaces averaged about 16 ms and
13 ms there.
