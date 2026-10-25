# Turn preparation: round trips before provider dispatch

Baseline source: `0eb7aa010e7ce` (25 October 2026). Scope: accepted work to the
first provider dispatch, not provider response latency.

## What the clocks mean

The canonical ledger in `packages/db/src/index.ts`
(`startupMilestoneForEvent` / `canonicalTurnStartupMilestonesForInsertedEvents`) measures
from **turn creation**, not activity entry:

- `queue` ends at `turn.started`. That event is emitted **after** atomic claim,
  session/capability reads, execution-policy fencing and initial allowance checks.
  It is not a pure Temporal scheduling or message-to-claim timer.
- `provider_dispatch` ends at the first `agent.model.request` started checkpoint.
  This durable pre-wire audit is fenced, but its event timestamp precedes the
  audit commit. The separate transport-dispatch observer records the actual
  handoff clock. The benchmark below uses that later boundary, including audit
  latency, rather than calling the audit timestamp a completed network send.
- `first_byte` also starts at turn creation. It is not provider-only latency.

Thus a reported queue p50 of 460 ms and claim-and-policy p50 of 420 ms must
**not** be added. Nor can p50s/p90s of different populations be subtracted to
produce a measured exclusive phase. The reported dispatch p50/p90 of
1,430/2,580 ms includes both queue and worker preparation.

Nesting in the worker:

```text
turn created -> scheduling -> activity entry
  claim_and_policy
    claim_catalog_read
    claim_atomic
      transaction admission + RLS setup + scoped_callback + commit
        claim_continued_accounts (continuations only; nested RLS scopes)
    session/capability reads; provider settings; execution policy; allowance
  turn_start_settlement -> turn.started (queue milestone)
  learning-policy freeze || attachment-authority projection
  credential_selection (subscription paths)
    identity; health; entitlements; placement; selection receipt
  runtime_preparation
    governance; session MCP settings; compaction preparation;
    tool policy; sandbox route/resources/credential preparation
  sandbox establishment and file resolution, where required
  tool_context_preparation
  tools-start event write
  tool_preparation
    server construction/connect; catalog build; catalog persistence
  tools-completed event write; post-tool preparation; agent/history construction
  request preparation; live dispatch gates/history checkpoint; durable audit
  wire dispatch
```

`claim_scoped_callback`, `claim_rls_setup` and admission observations aggregate
all scopes in one claim. Nested callbacks overlap their parents: their sums
are not exclusive elapsed time. `credential_entitlement_refresh` can start
after atomic claim and overlap subsequent claim work; `credential_entitlements`
later includes joining that preparation. `tool_context_preparation` precedes,
rather than nests inside, `tool_preparation`. Phase-event writes and durable
request audits explain gaps that are not assigned to the neighboring phase.

The example timeline with 590 ms to `turn.started`, then 310 ms before tools,
110 ms in tools, 95 ms before model preparation and 44 ms in preparation accounts
for 1,149 ms of its 1,248 ms to dispatch. The remaining roughly 99 ms is not
evidence of model latency: request admission/checkpoint/audit and unmeasured
inter-stage work still precede the wire boundary.

## Acceptance and execution path

1. The API's session-message route reaches
   `acceptSessionUserMessageWithOutcome` / `postUserMessageTurn` in
   `packages/core/src/domain/sessions.ts`. Authentication, model/resource
   validation and account selection precede durable acceptance.
2. `submitHumanPromptInTransaction` in `packages/db/src/session-queue-commands.ts`
   admits the command under subject RLS and the canonical control/session lock
   prefix. Message, queued turn, receipt and workflow-wake revision commit
   together. Durable events precede live publication.
3. The wake outbox survives failures. `apps/api/src/index.ts` uses Temporal
   `signalWithStart(sessionWorkflow, queueChanged/sessionControl)` and records
   delivery after acceptance. The control workflow's `peekSessionWork` is an
   advisory observation, not claim authority. It dispatches `runAgentTurn` to
   the turn worker with a stable attempt identity.
4. `claimTurnAttempt` resolves deployment catalog settings, then
   `claimSessionWorkForAttempt` rechecks live control, expiry and quiescence,
   consumes eligible work and registers the exact attempt. Continued-account
   resolution remains **inside this transaction**. Frozen governance and
   accepted history are durable before claim returns.
5. Post-claim session, capability and execution-policy preparation precede
   initial allowance checks and `turn.started`. Later learning, personal-resource,
   model-connection, credential-placement and tool-catalog checks retain their
   existing authority boundaries.
6. Runtime preparation and the request path in
   `apps/worker/src/activities/agent-turn/run.ts` still checkpoint history and
   audit the model request before transport. No model call is moved ahead of
   these writes.

The benchmark exercises steps 2, 4, 5 and 6 with real PostgreSQL and the
production worker/runtime, dispatching the activity immediately after admission.
It does not measure HTTP, Temporal task queues, NATS transport, external MCPs,
subscription-provider entitlement/token calls, or a physical sandbox. Those
unmeasured providers must not be claimed as improved by these numbers.

## Changes and safety

- **Overlap independent post-claim scopes.** Session and capability reads now
  overlap the trigger read and the existing exact-attempt policy fence when
  the accepted policy is already valid. Each uses the root pool, never concurrent
  subject-changing savepoints on one connection. `allSettled` joins every scope
  before failure handling. A missing legacy policy still derives its restriction
  from fresh session/provider settings at the original installation boundary.
  No pre-claim speculation or new authority cache is introduced. Subsequent
  settlement, tool and dispatch fences still reject a superseded attempt.
- **Reuse locked connector configuration during continuation claim.** The claim
  already holds the session row; it passes a connector-typed view of that row
  to its callback and reads session-local MCP metadata in that same transaction.
  The resolver no longer loads the complete session's UI/control/current-account
  projection again. Workspace defaults, installed connectors, membership and
  actual accounts are still resolved live. The carried principal is still
  narrowed to the initiating human before this callback.
- **Do not read accounts no route can use.** With no selected connection-backed
  MCP server, generic-account discovery has no consumer. Dedicated repository,
  social and Atlassian resolution still runs normally. A social-only selection
  needs its live membership and social-account reads, not unrelated native
  connection metadata. Selected MCP/repository/Atlassian routes retain their
  original reads; revoked/ambiguous selections retain their original outcomes.
- **Remove an overwritten policy read.** `getSession` used to project effective
  model settings in its cursor helper and again in `mapSessionWithControl`.
  It now skips the first projection, retaining the later same-statement
  row/default/boundary resolution, canonical cursor checks and control projection.

No SQL migration, lock removal, authorization cache, prompt/history projection,
tool schema, description, ordering, budget, throttle or Temporal workflow change.
The benchmark compares ordered request JSON without sorting keys or arrays;
only fixture-generated UUIDs and timestamps are normalized.

## Reproduction

```sh
OPENGENI_REQUIRE_REAL_DB=1 \
  OPENGENI_TEST_PG_URL=postgres://postgres:x@127.0.0.1:61440/postgres \
  OPENGENI_BENCH_SAMPLES=30 \
  bun scripts/bench-turn-predispatch.ts .predispatch/direct.json
```

Use a disposable pgvector-enabled fixture cluster, not a production database.
The harness creates/releases its own migrated clone and uses the restricted
application role with FORCE RLS. It records SQL texts but never parameters.
Five warm-up pairs are excluded. Each measured pair contains a new user message
with an admission-frozen policy, followed by a child-result continuation carrying
that human's account intent. The scripted transport calls the real pre-wire
checkpoint and dispatch observers; no paid provider calls are made.

Set `OPENGENI_BENCH_DB_ONE_WAY_MS=1` for the controlled round-trip sensitivity
experiment: a loopback TCP proxy delays each ordered stream chunk by 1 ms in
each direction. PostgreSQL, migrations, application-role RLS and every worker
write remain real. This is **not** a measured production RTT. Compare the same
harness on the baseline and candidate, and reverse run order to check drift.

Compare the full ordered requests and summarize both run pairs with:

```sh
bun scripts/compare-turn-predispatch.ts \
  before-1.json after-1.json before-2.json after-2.json
```

The comparator fails if any ordered request differs within or between revisions
after normalizing fixture UUIDs, ISO timestamps and the rendered UTC timestamp
format used in message/update headers. It does not sort schemas or messages.

## Results

The controlled experiment ran baseline, candidate, candidate, baseline; each
batch excluded five warm-up pairs and retained 30 measured pairs. Thus each
scenario/revision has **60 samples**. The full distributions, individual dispatch
samples and ordered-request hashes are in
[`turn-predispatch-results.json`](turn-predispatch-results.json).

All times below are milliseconds. Dispatch is the actual scripted transport
handoff after the real durable pre-wire audit, not provider response latency.

| Scenario | Before p50 / p90 | After p50 / p90 | Before / after mean |
| --- | ---: | ---: | ---: |
| New accepted message → dispatch | 1,194 / 1,517 | 1,106 / 1,434 | 1,263.5 / 1,169.7 |
| Continuation admission commit → dispatch | 1,253 / 1,670 | 1,134 / 1,470 | 1,339.8 / 1,199.9 |

The new-message median falls **88 ms (7.4%)**, and the continuation median falls
**119 ms (9.5%)**. Both run pairs improve: new-message medians are 1,114 → 1,058
and 1,225 → 1,192; continuation medians are 1,189 → 1,076 and 1,302 → 1,201.
There is still host-load drift, so these are benchmark results, not a prediction
of the production percentile gain.

Phase p50s (nested phases must not be summed):

| Phase | New message before → after | Continuation before → after |
| --- | ---: | ---: |
| `claim_and_policy` | 272.7 → 227.0 | 465.5 → 363.5 |
| `claim_atomic` | 126.2 → 125.1 | 311.5 → 225.1 |
| `claim_scoped_callback` (nested aggregate) | 112.8 → 112.8 | 365.7 → 236.5 |
| `claim_continued_accounts` | not applicable | 121.0 → 48.9 |
| `claim_session_read` | 38.5 → 36.2 | 37.6 → 36.5 |
| `claim_capability_settings` | 25.4 → 25.6 | 27.4 → 27.7 |
| `claim_provider_settings` | 28.0 → 28.1 | 27.6 → 27.7 |
| `turn_start_settlement` | 62.9 → 63.3 | 62.0 → 60.3 |
| `runtime_preparation` | 129.2 → 119.7 | 132.5 → 119.5 |
| `tool_context_preparation` | 69.1 → 68.6 | 68.7 → 66.8 |
| `tool_preparation` | 124.5 → 125.6 | 106.7 → 105.9 |
| `post_tool_preparation` | 66.4 → 64.5 | 55.3 → 55.0 |
| `history_preparation` | 52.7 → 51.8 | 52.3 → 52.3 |
| `model_request_preparation` | 41.5 → 39.7 | 40.7 → 39.5 |
| `model_request_audit` | 47.8 → 47.8 | 49.4 → 44.9 |

The unchanged tool, history and audit phases are intentionally not bypassed.
Credential-selection/entitlement phases are absent in this scripted-provider
fixture; no savings are claimed for them.

### Database work

Driver debug captures count SQL command submissions (including transaction/RLS
setup and savepoint commands), not TCP packets. The atomic claim uses one
connection and serial awaited commands. Post-claim independent root-pool scopes
overlap, so the total command count is not a count of serial network waits.

| Median command count | New message before → after | Continuation before → after |
| --- | ---: | ---: |
| Atomic claim, `BEGIN` through `COMMIT` | 37 → 37 | 93 → 66 |
| All activity SQL through wire dispatch | 374 → 373 | 427 → 399 |
| Root transactions through dispatch | 56 → 56 | 56 → 56 |
| Savepoints through dispatch | 7 → 7 | 14 → 10 |

For a continuation, 27 serial commands leave the atomic critical section; the
remaining one-command saving is the overwritten post-claim effective-policy
projection. No durability transaction was removed. For a new message, the main
gain is overlap: policy fence and trigger no longer follow the session/capability
join and provider-settings preparation serially. Statement totals can vary by
one with attempt-local background work; all raw samples end at the wire boundary.

### Direct loopback cross-check and limits

An earlier direct-loopback run with no injected delay retained 30 samples per
scenario/revision. New-message dispatch p50/p90 was 301/586 → 302/480 ms;
continuation was 328/620 → 321/518 ms. This run did **not** demonstrate a reliable
new-message median improvement. The controlled-delay experiment establishes
round-trip sensitivity and the SQL counts establish the structural reduction;
neither is a measured production rollout result. HTTP/Temporal scheduling and
external provider/MCP/sandbox latency still require production observation.

### Correctness checks

- Final targeted suite: **87 tests passed, zero failed, 1,059 assertions across
  11 files**, with real PostgreSQL required rather than silently skipped.
- All 240 controlled-run requests match byte-for-byte within each scenario
  after fixture-ID/time normalization, including message, tool and schema order.
- Held-promise tests prove post-claim concurrency, exact policy-fence inputs,
  rejection propagation and joining every scope before failure handling.
- Real PostgreSQL continuation tests compare the optimized projection against
  the old fresh-session resolver under the same transaction across reconnects,
  revocation, changed principals, removed connectors and ambiguous choices.
- Existing membership-fence, accepted-policy/restriction, personal-delegation,
  sender-account and startup-ledger tests remain enabled. The session-detail
  regression test verifies one effective-policy query and unchanged settings.
- `bun run typecheck`, changed-file `oxlint --deny-warnings` and `oxfmt` checks,
  migration ordinal/RLS-backfill/lock-order/deployment-mode/online-safety/schema/
  test-budget guards, public-hygiene, workflow-graph and public-API guards pass.
  There are no migrations or public API changes.
