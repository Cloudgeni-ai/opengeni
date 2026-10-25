# Turn preparation: round trips before provider dispatch

## Path and timing boundaries

1. API admission (`postUserMessageTurn` → `submitHumanPromptInTransaction`)
   validates access and accepts the message, queued turn, receipt and wake-outbox
   revision in one subject-RLS transaction with canonical control/session locks.
2. The durable wake outbox drives Temporal `signalWithStart`. The session workflow
   observes eligible work and dispatches `runAgentTurn`; that observation is not
   claim authority.
3. `claimSessionWorkForAttempt` locks and rechecks control, expiry, quiescence and
   eligible work, resolves continued accounts, and durably registers the attempt,
   frozen governance and accepted history. Post-claim session/capability/policy
   preparation and allowance checks precede `turn.started`.
4. The worker prepares credentials, runtime, tools and history. Before transport,
   live dispatch gates, history checkpoints and the request audit still commit.

The canonical startup milestones in `packages/db/src/index.ts` start at turn
creation. **`queue` ends at `turn.started`, not atomic claim**, so adding queue
and `claim_and_policy` double-counts work. `provider_dispatch` uses the first
`agent.model.request` started-event timestamp, before its audit commit; the
transport-dispatch observer records the later actual handoff. The benchmark
below measures that handoff, including the audit, but not model response time.

`claim_and_policy` contains `claim_atomic`; continued-account resolution is
inside that transaction. Scoped-callback/RLS observations aggregate nested
scopes and are not exclusive durations. Credential selection contains identity,
entitlements, placement and selection receipts; entitlement refresh can overlap
post-claim work. `tool_context_preparation` precedes `tool_preparation`; phase
event writes and request audits account for some inter-phase gaps. Do not add
nested phases or subtract independent percentile populations.

## Changes and preserved guarantees

- **Overlap independent post-claim scopes.** For an already-valid accepted policy,
  its exact-attempt fence and trigger read overlap session/capability reads on
  separate root-pool connections. `allSettled` joins all scopes before failure
  handling. Legacy policy installation still derives restrictions from fresh
  session/provider settings at the original boundary. No pre-claim speculation.
- **Reuse locked connector configuration.** Continuation resolution consumes the
  session row already locked by the claim, plus session-local MCP metadata,
  instead of reloading its full UI/control/model projection. Workspace defaults,
  membership, installed connectors and actual accounts remain live reads inside
  the transaction; the causal human is still narrowed before resolution.
- **Skip account reads with no consumer.** No selected connection-backed MCP
  route means no generic account discovery. Social-only paths retain membership
  and social-account reads without unrelated native metadata. Selected MCP,
  repository and Atlassian paths retain their original authority checks.
- **Remove an overwritten policy read.** `getSession` retains the later fresh
  effective-policy query, cursor checks and control projection, rather than
  projecting the same policy twice.

No durability transaction, dispatch fence, prompt/history projection, schema,
description or input order changes. No authority cache, cap or throttle.

## Measurements

Baseline: `0eb7aa010e7cec8b2e6b328e55dd783356b5003b`. Real migrated PostgreSQL,
restricted application role with FORCE RLS, production worker/runtime, scripted
model and local event bus. No paid provider calls. Baseline/candidate/candidate/
baseline run order, 30 measured new-message/continuation pairs per batch after
five warm-up pairs: **60 samples per scenario and revision**.

A loopback TCP fixture adds 1 ms per ordered stream chunk in each direction.
This is a round-trip sensitivity experiment, **not a measured production RTT**.
It excludes HTTP/Temporal transport, subscription entitlement/token calls,
external MCPs and physical sandbox startup.

| Actual dispatch latency, ms | Before p50 / p90 | After p50 / p90 | Before / after mean |
| --- | ---: | ---: | ---: |
| Accepted new message → dispatch | 1,194 / 1,517 | 1,106 / 1,434 | 1,263.5 / 1,169.7 |
| Continuation admission commit → dispatch | 1,253 / 1,670 | 1,134 / 1,470 | 1,339.8 / 1,199.9 |

Both run pairs improve: new-message p50s are 1,114 → 1,058 and 1,225 → 1,192 ms;
continuation p50s are 1,189 → 1,076 and 1,302 → 1,201 ms.

| Phase p50, ms (nested; not additive) | New message before → after | Continuation before → after |
| --- | ---: | ---: |
| `claim_and_policy` | 272.7 → 227.0 | 465.5 → 363.5 |
| `claim_atomic` | 126.2 → 125.1 | 311.5 → 225.1 |
| `claim_continued_accounts` | — | 121.0 → 48.9 |
| `claim_session_read` | 38.5 → 36.2 | 37.6 → 36.5 |
| `claim_capability_settings` | 25.4 → 25.6 | 27.4 → 27.7 |
| `claim_provider_settings` | 28.0 → 28.1 | 27.6 → 27.7 |
| `turn_start_settlement` | 62.9 → 63.3 | 62.0 → 60.3 |
| `runtime_preparation` | 129.2 → 119.7 | 132.5 → 119.5 |
| `tool_context_preparation` | 69.1 → 68.6 | 68.7 → 66.8 |
| `tool_preparation` | 124.5 → 125.6 | 106.7 → 105.9 |
| `history_preparation` | 52.7 → 51.8 | 52.3 → 52.3 |
| `model_request_preparation` | 41.5 → 39.7 | 40.7 → 39.5 |
| `model_request_audit` | 47.8 → 47.8 | 49.4 → 44.9 |

| Median SQL command count | New message before → after | Continuation before → after |
| --- | ---: | ---: |
| Serial atomic claim, `BEGIN` through `COMMIT` | 37 → 37 | 93 → 66 |
| All activity SQL through dispatch | 374 → 373 | 427 → 399 |
| Root transactions | 56 → 56 | 56 → 56 |
| Savepoints | 7 → 7 | 14 → 10 |

These are driver command submissions, including transaction/RLS/savepoint
commands, not TCP packets. The atomic claim is serial on one connection;
independent post-claim scopes overlap. Background work can vary totals by one.

An earlier direct-loopback run without injected delay (30 samples per scenario/
revision) gave new-message p50/p90 **301/586 → 302/480 ms**, continuation
**328/620 → 321/518 ms**. It did not establish a reliable new-message median gain.
Shared-machine drift remains visible; neither experiment predicts production
percentiles. Credential/entitlement phases are absent in this scripted fixture.

## Remaining serial claim work

The measured continuation still issues 66 commands before its atomic commit.
The following disjoint groups cover one representative candidate trace in order;
counts identify round-trip opportunities, not per-statement execution cost.

| Command positions | Count | Work still serialized |
| --- | ---: | --- |
| 1–3 | 3 | Transaction, outer RLS setup and claim savepoint |
| 4–14 | 11 | Canonical lock/control prefix, session/cursor projection, realtime/interruption/quiescence and active-attempt checks |
| 15–30 | 16 | Eligible queue/update selection, prior-turn/history context, causal authority inheritance and effective continuation policy |
| 31–45 | 15 | Session connector metadata, workspace settings and live capability/API-facet reads, including nested subject-RLS setup/restoration |
| 46–54 | 9 | Continuation insertion, subscription-authority copy, accepted history insertion and connector approval snapshots |
| 55–66 | 12 | Session activation, attempt/protocol registration, frozen instruction/preference snapshots, event/final state writes, RLS check and commit |

The largest follow-up candidates are consolidating continuation/update/context
lookups (16 commands) and live capability projections plus their nested RLS
plumbing (15). Activation/finalization (12) and admission/control checks (11)
need dependency/lock-order analysis before batching. Preserve causal membership,
exact-attempt fencing, snapshot atomicity and the final commit; do not parallelize
subject-changing scopes on one transaction connection or move authority to caches.

## Rerun and validate

Create a disposable baseline worktree at the SHA above and run
`bun install --frozen-lockfile` in both worktrees. Set `BASELINE_WORKTREE` to its
absolute path. Supply a disposable pgvector-enabled PostgreSQL maintenance URL
with permission to create databases/roles; the harness creates and releases its
own migrated restricted-role clone. Do not use a production database.

```sh
cp scripts/bench-turn-predispatch.ts "$BASELINE_WORKTREE/scripts/bench-turn-predispatch.ts"
export OPENGENI_REQUIRE_REAL_DB=1
export OPENGENI_TEST_PG_URL=postgres://postgres:x@127.0.0.1:61440/postgres
export OPENGENI_BENCH_SAMPLES=30
export OPENGENI_BENCH_DB_ONE_WAY_MS=1
bun "$BASELINE_WORKTREE/scripts/bench-turn-predispatch.ts" .predispatch/before-1.json
bun scripts/bench-turn-predispatch.ts .predispatch/after-1.json
bun scripts/bench-turn-predispatch.ts .predispatch/after-2.json
bun "$BASELINE_WORKTREE/scripts/bench-turn-predispatch.ts" .predispatch/before-2.json
bun scripts/compare-turn-predispatch.ts \
  .predispatch/before-1.json .predispatch/after-1.json \
  .predispatch/before-2.json .predispatch/after-2.json
```

Set `OPENGENI_BENCH_DB_ONE_WAY_MS=0` for the direct-loopback cross-check. Keep
generated raw results local, not in Git. The comparator prints distributions and
fails if ordered requests differ after only fixture UUID/ISO/rendered-UTC time
normalization; it never sorts messages, tools or schemas. All 240 measured
requests matched within their scenario.

Verification: 87 targeted tests, 1,059 assertions, real PostgreSQL required;
typecheck, changed-file lint/format, migration guards, public hygiene, workflow
graph and public-API guards. Tests cover held-scope failure joins, stale policy
fences, legacy restrictions, current-account revocation/reconnect/principal
changes, optimized/original resolver equivalence, and the single policy read.
