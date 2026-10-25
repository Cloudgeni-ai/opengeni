# HTTP model-catalog metadata scope

`GET /v1/workspaces/:workspaceId/model-catalog` reuses
`loadWorkspaceModelCatalogInputs`, the same public-metadata loader used by core
model selection. One fresh scope reads workspace connection metadata, workspace
custom models and organization provider metadata. The route keeps its original
provider lists, credential exclusion, readiness/discovery calls and default
selection. Existing transaction handles retain the previous reader path.

The scope checks workspace existence and account consistency under the shared
tenancy fence. Individual SELECTs retain READ COMMITTED freshness; this is not a
coherent snapshot or authority cache. A metadata failure remains fatal, including
when the restriction reader uses its existing standalone fallback.

## Reproduce

With the repository's disposable PostgreSQL test environment:

```sh
BENCH_BASE_REF=<exact-pre-change-revision> bun scripts/operator/bench-http-model-catalog.ts
bun test apps/api/test/model-catalog-scope-postgres.test.ts
```

The benchmark loads the exact base API/router source with the same dependencies
and database. It uses the actual in-process HTTP handler, organization-key and
external-actor authentication, empty catalogs and thirty workspace custom models
across three providers. External network calls are prohibited. Five warmup pairs
precede forty alternating measured pairs per case. Full response bytes must match.

Measured against `8f3070ac380ac17b688c55b8a8936b0aa9f5be0c`:

| Caller | Statements before → after | Transactions before → after |
|---|---:|---:|
| Organization key | 61 → 56 | 12 → 10 |
| External actor | 65 → 60 | 13 → 11 |

Counts matched for empty and populated fixtures; all 180 response pairs matched.
Local elapsed medians were approximately 14–21 ms, essentially unchanged; CPU
results were mixed. These measurements establish fewer statements and transactions,
not a live latency/CPU improvement. They exclude real HTTP transport and ingress,
subscription discovery, large organizations and production pool contention.

This change does not alter the client-config or session-list routes and does not
claim to resolve all causes of slow chat opening.
