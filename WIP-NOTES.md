# Session create/read latency — WIP checkpoint

Work stopped at the user's request on October 5, 2026. This is an incomplete
checkpoint, not a release-ready change. No pull request or merge is authorized.
Initial base: `e852eb7` (the current `main` when this work began).

## Measured baseline

Real loopback HTTP requests through `createApp`, native PostgreSQL 17 + pgvector,
restricted `opengeni_app` role, real NATS 2.11.8 and Temporal CLI 1.4.1.
Ten measured samples after one warm-up, each using a fresh organization-key
workspace. Create uses default tools, omitted model, `initialMessage: "Hello"`,
and `sandboxBackend: "none"`. A fixture model credential enables selection;
no worker polls the isolated benchmark queue and no model request is dispatched.

| Endpoint | SQL statements | BEGIN transactions | SAVEPOINTs | Wall p50 | HTTP span p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| POST sessions | 1,016 | 91 | 8 | 382.27 ms | 380.59 ms |
| GET session detail | 270 | 28 | 0 | 100.29 ms | 98.34 ms |
| GET new-session-draft | 449 | 44 | 0 | 92.09 ms | 89.14 ms |

Statement counts come from postgres-js dispatch diagnostics and include
BEGIN/COMMIT/SAVEPOINT statements. They are not a wire-packet or exact network
round-trip count. These are local measurements, not production results.
`stream-capabilities` has not been measured.

Create phase p50s: authorization 6.82 ms; workspace read 6.62 ms; default-model
resolution 51.27 ms; capability settings 40.00 ms; initiator freeze 6.42 ms;
allowance 9.01 ms; shell insert 33.28 ms; atomic initialization 46.91 ms;
NATS event fanout 2.01 ms; workflow wake 27.93 ms; session reload 18.15 ms;
response projection 47.39 ms. Core create totals 315.85 ms. Fanout and wake
already overlap on the original main; that is not a new optimization.

The evidence confirms substantial database chatter. It does not establish the
cause of the supplied production trace's unspanned gap or prove a production
latency target. No final candidate before/after comparison was completed.

## Fixes present

1. `packages/db/src/database.ts`: combine tenant/protocol and ambient actor
   `set_config` writes into one SELECT. With an actor, `setRlsContext` changes
   from four statements to two. The independent subject read-back remains;
   account/workspace read-back after the tenancy advisory lock is unchanged.
   The shared tenancy lock, nested scope restoration, transaction boundaries,
   and session activity commit gate remain intact. No migrations.
2. `packages/core/src/model-catalog.ts`: use existing batched active workspace
   and organization provider catalog readers. Separate retained/retired-model
   execution lookups remain. Historical minimal test ports retain their fallback.
3. `packages/core/src/default-session-model.ts`: batch provider models/readiness
   and reuse connection metadata within one loader invocation. Preserve canonical
   Claude subscription pool authority and separate fresh admission reads; no
   cross-request or mutable-authority cache. This worker's final validation
   result had not been delivered when work was stopped.
4. Session response policy projection hydrates the workspace once per response
   for both policy contexts. Session GET overlaps independent enrichments only
   after the authorized session read, joins all results, and preserves error
   precedence. Injected transaction handles keep serial enrichment ordering.
5. Added content-free GET spans and additional create resource/admission spans.
   Existing read-back checks, durable initialization/wake, frozen principals,
   and post-commit create response error boundary are retained.
6. `scripts/operator/bench-session-latency.ts`: reproducible real-service
   benchmark with statement/transaction counts, per-phase timings and optional
   backend-response-delay relay. Included in operator typechecking. The delayed
   original-main comparison was started, but its result was not reconciled
   before stopping. The relay is simulation, never production RTT evidence.

## Validation completed

- `bun run typecheck`: latest completed run reports all 36 projects clean.
- Parent focused suite: 58 passed, 0 failed across RLS input/query budget,
  PostgreSQL nested actor restoration, database timing, real PostgreSQL provider
  batch equivalence/isolation/limits, model catalog source, Claude catalog,
  and create-phase coverage tests.
- Parent safety suite: 43 passed, 0 failed across transaction provenance,
  model-catalog prompt replay, startup timing/dispatch overlap and dedicated-schema
  tests. **The dedicated-schema suite's live database assertions skipped because
  it requires Docker; do not count those assertions as PostgreSQL coverage.**
- Projection worker delivered a completed result: 60 focused unit tests passed;
  real PostgreSQL effective-tools routes, client model admission,
  session authorization read reuse and scheduled-session targets passed;
  API/core typechecks, targeted lint/formatting, workspace-billing static and
  diff checks passed.
- Whole-tree `oxlint --deny-warnings .` is **not verified green**. The last
  parent run (`bun x oxlint --deny-warnings .`) failed on an ignored diagnostic
  helper, `packages/db/.pgq-tmp2.ts`, with an unused catch parameter. No further
  lint run or unrelated cleanup was performed after the stop request.
- The final combined snapshot has not undergone independent review or CI.

## Span names

New GET: `api.session_get.authorization`, `api.session_get.session_read`,
`api.session_get.background_commands`, `api.session_get.schedules`,
`api.session_get.response_projection`. The authorization span covers the
handler's grant check, not upstream middleware.

Additional create: `core.session_start.repository_selection`,
`core.session_start.file_resources`, `core.session_start.rig_default`,
`core.session_start.model_policy`, `core.session_start.model_selection`.

The existing `api.session_create.*` and `core.session_start.*` phase spans were
used for the baseline. Collector allowlist updates/documentation remain undone.

## Remaining work

- Run final direct and delayed-response before/after benchmarks on identical
  services/settings; record statement/transaction counts and p50/p95 per route.
- Reconcile default-model worker tests, review all combined changes and rerun
  touched real PostgreSQL suites, typecheck and whole-tree lint as necessary.
- Obtain independent review of RLS setup and tenant/actor restoration; do not
  remove or weaken independent read-back checks or the tenancy lock.
- Document exact before/after RLS SQL and each preserved read-back invariant.
- Complete trace allowlist documentation and validate remaining upstream auth
  middleware coverage. Do not claim the production latency goals are met.
- The full dev launcher was blocked by an unrelated unavailable prebuilt
  artifact runtime and missing Rust/C build prerequisites. The native
  database/API/NATS/Temporal manual path did run; Office rendering and actual
  model execution were not validated.
- Native fixture services and the detached original-main comparison worktree
  were retained locally; generated logs, dependencies and local credentials
  are ignored and are not part of this commit.
- No PR, CI monitoring or merge should occur unless the user resumes the task.