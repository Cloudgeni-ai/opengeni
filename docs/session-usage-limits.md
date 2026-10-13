# Session (task) usage limits

A task usage limit stops a task from starting new model requests once its
recorded API-equivalent model usage reaches an amount a person or the
product's server chose. A **task** is a root session and every descendant
(child agents, their children, and so on). The limit is optional: every new
task is unlimited unless a limit is supplied.

This is a guard on recorded model usage, not an invoice cap. It is checked
before each new model request and never reserves money, so requests that were
already admitted can finish and take recorded usage above the limit, and
several requests admitted at the same time can overshoot together. There is no
fixed bound on that overshoot.

Canonical sources: contracts in `packages/contracts/src/session-usage-limits.ts`
and the zod-free refusal leaf `packages/contracts/src/session-usage-limit-refusal.ts`;
storage, settlement and import in `packages/db/drizzle/0759_session_usage_limits.sql`
and `packages/db/src/session-usage-limits.ts`; authority, edge admission and
write rules in `packages/core/src/session-usage-limits.ts`; worker admission in
`apps/worker/src/activities/agent-turn/admission.ts`; HTTP routes in
`apps/api/src/routes/sessions.ts`; diagnostics in
`packages/core/src/session-usage-limit-metrics.ts`. Workspace and member
spending ceilings are a separate feature: see [usage allowances](usage-allowances.md).

## What is counted

The unit is integer USD micros (`$1 = 1_000_000`) on the versioned basis
`model_api_equivalent_v1`: the canonical **pre-margin** provider cost estimate
(`estimatedProviderCostMicros`) that model settlement already computes for
every model response. It is a configured list-price estimate or the cost
reported by the AI Gateway or Opper. The same amount is counted whatever funds
the call: Opengeni credits, a connected subscription, a workspace or
organization key, or a self-hosted deployment with billing disabled. The
Opengeni margin, the credit debit and Insights display totals are never the
measure, and recording a receipt never changes credits, usage events or
entitlements.

Counted, once per durable source identity:

- every main-turn model response of the root and of every descendant;
- session title generation and every compaction call;
- responses during provider recovery or retries that actually report usage
  (a replayed settlement counts once; a genuinely new response counts again);
- calls to `POST /v1/workspaces/:workspaceId/chat/completions` made with a
  live agent attempt credential, counted against that attempt's task.

Not counted in v1: sandbox compute, image and video generation, voice, paid
web search, embeddings and Knowledge indexing, third-party tools, and stateless
single-model calls by people, hosts or services (they have no task).

Unknown cost is not zero. A response without a known price is recorded as
**unpriced**, excluded from `usedMicros`, and disclosed through
`unpricedCalls` and `coverage: "partial"`. A model with a configured price of
zero is **known free**: it counts as zero and increments `freeCalls`. A
provider that reports only an aggregate usage at the end of a turn is counted
once, and the limit can only act at that turn's next boundary.

A database failure while recording a known price is not unknown pricing. The
worker routes it through exact-attempt PostgreSQL recovery and dispatches no
further model request until the receipt is recorded; the provider is never
called again for that response. For attempt-authenticated single-model calls,
the API process retains the exact failed settlement, retries only the database
write with bounded backoff, and refuses that session's next call (HTTP 503
`session_usage_limit_unavailable`) until the retained receipt is recorded. That
retention is per API process and bounded; a process crash before recovery loses
the receipt, which is logged and counted.

## Scope of one limit

- The limit belongs to the root. Every descendant counts against it regardless
  of model, funding, sandbox placement or creator. Reading a child returns the
  root's state with `inherited: true`; only the root's limit can be changed.
- A child cannot hold its own limit, and creating a child with
  `usageLimitMicros` is refused.
- Deleting or archiving a child keeps its receipts: they are stored against
  the root without a foreign key to the child, so a surviving root never loses
  spend. Deleting a quiescent root removes its accounting with it. A response
  that settles after its session was already deleted cannot be attributed and
  is not counted (diagnostic outcome `source_gone`).
- A fork made by a person is a new root that starts unlimited with no copied
  usage. Switching models or latency, sharing a sandbox or removing a
  credential does not change which task is metered.
- A schedule that targets an existing session uses that session's task limit.
  A schedule that creates a new root is a separate, unlimited task. Work sent
  to an unrelated session (a peer message) is metered to the receiving task.
  Calls made with independently held keys or from arbitrary sandbox networking
  are outside the meter.

## When the limit is reached

`usedMicros >= limitMicros` refuses the next model request. `0` means no model
request can start; `null` means no limit.

The check runs before a turn's first request (the parallel title request
starts only alongside an admitted first request), before every later request
in the turn, before each compaction summary or Codex remote compaction
request, and before each attempt-authenticated single-model call.

- **Before a turn's first request.** The worker records a completed, non-failed
  turn whose `turn.completed` payload has `segmentLimit: "session_usage_limit"`
  and a typed `sessionUsageLimit` refusal, and the session returns to idle.
  No `turn.failed`, no `usage.exhausted`, no `budget_exhausted` and no credit
  wording is produced.
- **Between requests in a running turn.** Already admitted requests finish and
  their full usage is recorded. History and tool outputs stay paired and the
  turn stops with the same marker.
- **Goals.** An active goal on the stopping session pauses in the same
  transaction with `pausedReason: "session_usage_limit"`. Goal continuation and
  goal resume check the limit first; resume returns HTTP 422 while the limit is
  reached.
- **Fresh messages.** Send, Steer, composer submit, retry and creating a child
  under a reached task are refused with HTTP 402 `session_usage_limit_reached`
  before any queue, interrupt, draft or turn write, so a composer keeps its
  draft. An exact replay of an already committed request still returns its
  committed result. Retry is not the remedy; raising or removing the limit is.
- **Wakes.** Child results, schedules on the existing session, approvals,
  worker recovery and repeated wakes each settle at most one stop for the
  claimed work and never loop.

Raising, lowering or clearing a limit changes capacity only. It never resumes a
paused goal, a stopped turn, a child or a background command: a goal needs an
explicit Resume, a goalless session the next message. Lowering a limit below
current usage stops later admission but does not cancel requests already
running. Usage is never reset by changing, clearing or re-adding a limit, and
clearing a limit does not stop accounting.

## Reading and changing a limit

```http
GET /v1/workspaces/:workspaceId/sessions/:sessionId/usage-limit
PUT /v1/workspaces/:workspaceId/sessions/:sessionId/usage-limit
{ "limitMicros": 5000000 | null, "expectedVersion": 3, "operationId": "op-…" }
```

A create request may include `usageLimitMicros` for a new root. The response
includes `usageLimit` on create and on session detail. The read returns
`status` (`unlimited`, `within`, `reached`, `preparing`, `unavailable`),
`limitMicros`, `usedMicros` (null while preparing or unavailable; never show it
as `$0`), `history`, `coverage`, call counts, `version` and `usageRevision`.

Writes are compare-and-set on `version` and idempotent on `operationId`: a stale
version returns 409 `session_usage_limit_conflict` with the current version, and
the same operation replayed returns its committed state. Other write errors use
`details.code`: `session_usage_limit_not_root` (409, with `rootSessionId`),
`session_usage_limit_preparing` (409), `session_usage_limit_forbidden` (403),
`session_usage_limit_disabled` (422) and `session_usage_limit_unavailable`
(503). Every successful change appends `session.usage_limit.updated` to the
root and writes an audit receipt naming the person or host.

### Authority

Only a signed-in person or the product's trusted server may set, change or
remove a limit, with ordinary `sessions:control` on the root. Another person
who can control a shared root can change its limit. Refused, with no database
change:

- agent attempt credentials and session-scoped service bearers;
- agents acting as a delegated person (`isAgentActingAsPerson`) and session
  admin access, including the organization MCP surface;
- personal API keys, drafts and config side doors, Codemode and the generated
  MCP action catalog (the PUT route is browser-only in the catalog);
- a create request for a child, and any actor in another tenant.

`principalKind` alone is never treated as proof of a person. Reads follow the
session's normal authorization, private-session visibility and RLS, and expose
only aggregate task state: no hidden child titles, actors or other roots.

### Embedded products

The browser session proxy does not forward limit configuration. The browser
cannot send `usageLimitMicros` on create, the `usage-limit` routes are not on
the proxy's allowlist, and the proxied client config omits the
`sessionUsageLimits` capability. Set a limit from your server, either in the
proxy's `createSession` hook or with the server SDK:

```ts
const session = await og.createSession(workspaceId, {
  initialMessage,
  usageLimitMicros: 2_000_000, // $2.00 of API-equivalent model usage
});
await og.setSessionUsageLimit(workspaceId, session.id, {
  limitMicros: null, // remove
  expectedVersion: session.usageLimit!.version,
  operationId: crypto.randomUUID(),
});
```

The SDK verifies the server's echo: if a server that predates usage limits
strips the field, `createSession` and `setSessionUsageLimit` throw instead of
silently running an unlimited task. A refusal surfaces as
`OpenGeniSessionUsageLimitReachedError` (never the allowance error), and
`@opengeni/sdk/session-usage-limits` plus `@opengeni/react` provide the parser,
neutral message and notice. Older clients that do not understand the new
marker show a generic stop, never credits or a monthly reset.

A stop is also an attention boundary: the `turn.completed` carrying
`segmentLimit: "session_usage_limit"` marks the session unread in the rail and
session tree (like a failure), because only a person can raise or clear the
limit. No explanatory model call is made. An active goal pauses with reason
`session_usage_limit`, and a stopped child reports its idle result to its
parent, whose own next turn is refused at claim before any provider work, so a
reached limit settles once per session without a refusal loop. Other segment
limits (`max_turns`, `budget_exhausted`) keep their existing attention
behavior.

## Tasks created before this feature

A root first touched by a read, write or settlement starts `preparing`. A
bounded, resumable maintenance step (run by each API replica's webhook pump
tick) imports the stored per-call cost snapshots of every session in the tree,
including private sessions and earlier years, exactly once per source identity
and at the stored rates. It never reprices history. When the import finishes
the history is `legacy_partial`: shown as "at least", because a missing old
record is not proof of no usage. While `preparing`, `usedMicros` is null, a new
limit cannot be set (409 `session_usage_limit_preparing`), and nothing is ever
admitted against a false zero. New live settlements during the import are
recorded once and are not double counted.

## Rollout and activation

`OPENGENI_SESSION_USAGE_LIMITS_ENABLED` defaults to `false` and is passed to the
API and both workers when set. It gates producers only:

- while `false`, a new non-null limit on create or PUT returns 422
  `session_usage_limit_disabled`, and `ClientConfig.sessionUsageLimits.enabled`
  is `false` so stock UIs hide the editor;
- persisted limits are still read and enforced, and an authorized clear
  (`limitMicros: null`) is still allowed for recovery.

1. Apply migrations 0759–0761 and provision the matching database roles. The
   tables live in `opengeni_private` with FORCE RLS and execute-only entry
   points; the runtime posture and schema-contract checks include them. 0760
   builds a partial attention index on `session_events` concurrently (rolling;
   its build time scales with the meaningful-event history), and 0761 replaces
   the cursor trigger routine so the attention frontier counts usage-limit
   stops. The pre-0760 `session_events_meaningful_attention_v2_idx` stays for
   older API processes during the rollout; drop it in a later rolling migration.
2. Upgrade **every consumer** first: API, control worker, turn worker, web,
   SDK/React, Slack and embedded hosts. A worker that predates this release
   would not enforce a persisted limit, and an older client would not
   understand the new stop marker.
3. Only then enable `OPENGENI_SESSION_USAGE_LIMITS_ENABLED`.

Turning the flag back off is not a kill switch for enforcement.

## Diagnostics

`opengeni_session_usage_limit_events_total{boundary, outcome}` counts decisions
with closed-set labels only. Boundaries: `create`, `child_create`, `send`,
`steer`, `goal`, `claim`, `between_calls`, `single_call`, `settlement`,
`write`, `import`. Outcomes distinguish `reached`, `unavailable`,
`accounting_failure`, `unpriced`, `recorded`, `duplicate`, `filled`,
`source_conflict`, `source_gone`, `cas_conflict`, `preparing`, `forbidden`,
`disabled`, `not_root`, `set`, `cleared`, `replayed`, `imported` and
`import_failed`. No session, workspace, subject, model, prompt or amount is a
label.

`scripts/bench-session-usage-limits.ts` measures admission and settlement on a
disposable PostgreSQL (`OPENGENI_TEST_PG_URL`): admission reads one indexed
counter row with no receipt or event scan at 0, 10k and 100k receipts; 20
concurrent settlements on one root serialize on that root's counter row only;
separate roots share no lock.
