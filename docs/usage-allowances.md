# Usage allowances

Usage allowances let a product set a workspace spending ceiling and optional
member ceilings without building its own model-usage meter. They govern actual
OpenGeni credit debits, not tokens, estimated provider expense, or purchased
seat counts. The organization's credit balance and ordinary execution
authority remain separate requirements.

Start with [product integration](product-integration.md) for organization keys,
tenant-to-workspace mapping, and explicit external-member onboarding. Typed
SDK details live in the [SDK reference](../packages/sdk/README.md); the
allowance schemas live in `packages/contracts/src/usage-allowances.ts`.
Storage/counter lifecycle: `packages/db/src/usage-allowances.ts` and
`packages/db/drizzle/0552_usage_allowances.sql`; HTTP authority:
`apps/api/src/routes/usage-allowances.ts`.

Accounting reads frozen, content-free attribution receipts for accepted turns,
scheduled runs, and paid Knowledge queries. Source lifecycle triggers copy only
the exact tenant, source identity, and initiating human. They grant no session
access and do not rewrite existing session/usage visibility policies.

## Rollout and activation

`OPENGENI_USAGE_ALLOWANCES_ENABLED` defaults to `false`. It gates creation
and changes of allowance configuration, grants, and non-null member rules,
not reading or enforcing policies already persisted.
While disabled, those producer writes return HTTP 409. Authorized
exact-version clear and `rule: null` recovery writes remain available; neither
operation bypasses its normal authority or version checks.

1. Apply migrations 0552–0554 together and provision the matching database roles.
2. Upgrade **every API, control-worker, and turn-worker consumer** to the
   allowance-aware release before allowing producers to write new policies.
3. Enable `OPENGENI_USAGE_ALLOWANCES_ENABLED` for the API producers, then
   configure plans through organization-authorized backend/admin flows.

The flag is not a budget-enforcement kill switch. Setting it back to false
must not make persisted policies invisible or let older consumers execute
accepted work without their allowance checks. Retain the compatible readers
and use an authorized versioned clear/rule change for policy recovery.
Migration rollout compatibility does not by itself authorize early activation.
All new allowance tables (including attribution, clear-replay and video
allocation receipts) live in `opengeni_private`, with no direct runtime grants.
The public data-schema lifecycle functions use explicit private-table references
and a pinned `pg_catalog, <data schema>, pg_temp` path. Older consumers retain
their exact table inventory; regression coverage runs the complete pre-allowance
readiness inspector/evaluator and role provisioner against the new schema.
The capability stamp remains bound to backend, transaction, data schema and
tenant even though its storage is private.

Debits and policy mutations advance an expired active window transactionally.
Switching from monthly to nonrenewing preserves settled usage in the current
window; it does not revive a stale window or reset its usage to zero.
The additive DB `getWorkspaceAllowanceState` helper returns `{ version, config }`,
including the tombstone revision when `config` is null. Existing nullable
`getWorkspaceAllowance` remains compatible. A clear with an `operationId`
replays its exact committed revision while that tombstone remains current,
bound to actor and expected version. A superseded clear replay conflicts and
cannot clear a subsequent configuration.
See [client/server compatibility](architecture.md#310-clientserver-compatibility-policy).

## PostgreSQL verification

The database suites use the existing shared fixture and its non-superuser
application/owner roles. Docker remains the default. To use an already-running
native PostgreSQL with `pgcrypto` and `vector` available, follow the shared
fixture's `OPENGENI_TEST_PG_NATIVE=1` contract in `packages/testing/src/shared-pg.ts`
(see `AGENTS.md`); it builds a fingerprinted template and creates an isolated
database for each test file.

## Units and enforcement

Every amount named `includedCredits`, `credits`, `limit`, `used`, `remaining`,
or `grantsRemaining` is an integer USD micro: **1 USD = 1,000,000 micros**.
Use nonnegative safe integers for configured amounts; a grant must be positive.
Never pass floating-point dollars or reinterpret a credit as one token. Shares
and threshold fractions are ordinary dimensionless numbers.

Allowances are ceilings, not reservations or a second prepaid wallet:

- Actual settled credit debits consume allowance. A positive allowance does not
  purchase credits, increase the organization's balance, or bypass billing.
- Admission checks the workspace ceiling and the initiating member's ceiling
  before costly work. Model-call cost is recorded afterward; existing prepaid
  media billing retains its own debit/refund lifecycle.
- The model producer waits for response settlement and admission before its next
  paid request. Delegated Send/Steer refuses fresh work before acceptance or
  interruption; an exact committed replay remains recoverable after exhaustion.
- One call can overshoot. Parallel admitted calls can overshoot together;
  there is no aggregate overshoot bound of one call. Already incurred cost is
  not reversed. The next admission is refused once the applicable ceiling is
  exhausted.
- Externally funded work, including connected subscriptions and BYOK calls
  without an OpenGeni credit debit, does not consume this allowance. Zero
  OpenGeni credit charge does not imply zero upstream expense.
- Exhaustion does not revoke membership or read access. Preserve conversation
  history and other authorized read/export paths.

Use `fraction` to display consumption in a product. Do not estimate enforcement
from a progress bar, token count, or a provider-price comparison.

## Configuration and authority

```ts
const allowance = await og.setWorkspaceAllowance(workspaceId, {
  includedCredits: 100_000_000, // $100 of OpenGeni credit debits
  period: "monthly",
  anchorDay: 1,
  memberDefault: "equal_share",
  thresholds: { workspace: [0.8, 1], member: [0.8, 1] },
  expectedVersion: 0, // initial creation only
});
```

The configuration is:

```ts
{
  includedCredits: number;
  period: "monthly" | "none";
  anchorDay?: number; // integer 1..31, UTC
  memberDefault?: "none" | "equal_share" | { share: number } | { credits: number };
  thresholds?: { workspace?: number[]; member?: number[] };
}
```

Monthly boundaries use UTC, not a member's or scheduled task's time zone.
`anchorDay` is clamped independently to each month's last day: day 31 means
February 28 or 29, then March 31. `"none"` has no recurring reset.
Changing the anchor does not clear active-window usage: the current accounting
key/bounds remain until its boundary, after which the new anchor applies.
Switching to `"none"` retains the active key and accumulated usage but removes
the reset time; switching back to `"monthly"` retains that usage and sets the
next monthly boundary. Always use the returned window and `resetsAt`, not a
newly computed window from the latest config alone.
Omitted `anchorDay` uses day 1; omitted `memberDefault` uses `"none"`.
Omitted workspace/member threshold lists default to `[0.8, 1]`; configured
thresholds must be greater than zero and at most one, with at most 16 values
per list.

| Operation | Required authority |
| --- | --- |
| Read workspace configuration | Workspace administration, verified human `account:admin`, or organization-key read authority |
| Read the full usage/member page | Operational workspace access plus workspace administration, `account:admin`, or organization-key read authority |
| Set or clear workspace configuration; add workspace grants | Full-access organization API key with literal `api_keys:manage`, or verified human `account:admin` |
| Set an existing member's split | Verified human workspace administrator or full-access organization key; `account:admin` alone is insufficient |
| Read `/usage/me` | The authenticated member; external products assert their verified user through `asUser` |

A workspace administrator cannot raise the workspace budget, clear it, or add
grants merely by being an administrator. A workspace-scoped key is not a
full-access organization key. Agent attempts cannot perform **any** allowance
write, even when their workspace grant contains administrator permissions.
Agent attempts are also refused all allowance API reads.
Keep all plan changes and top-ups in authenticated product-backend/admin flows.
Verified human organization budget administrators may read/configure a
same-organization shared workspace's budget without membership in that target.
This grants no operational workspace access, full usage roster, or member-split
authority. Workspace API keys and service principals cannot administer member
splits by carrying a workspace-admin-shaped grant.

The root `OpenGeniClient` exposes:

| SDK method | HTTP operation beneath `/v1/workspaces/:workspaceId` | Result |
| --- | --- | --- |
| `getWorkspaceAllowance(workspaceId)` | `GET /allowance` | Config plus version, or `null` |
| `setWorkspaceAllowance(workspaceId, request)` | `PUT /allowance` | Config plus version |
| `clearWorkspaceAllowance(workspaceId, request)` | `DELETE /allowance` | `{ version }` for the cleared lifecycle |
| `grantWorkspaceCredits(workspaceId, request)` | `POST /allowance/grants` | `{ operationId, credits, remaining, expiresAt }` |
| `setMemberAllowance(workspaceId, member, request)` | `PUT /members/:subjectId/allowance` or `/members/external/:source/:externalId/allowance` | `{ subjectId, rule, version }` |
| `getUsage(workspaceId, query?, options?)` | `GET /usage` | Paginated usage envelope |
| `getMyUsage(workspaceId, query?, options?)` | `GET /usage/me` | Usage envelope with own member row only |

Use the root SDK against the product proxy for `getMyUsage`; allowance
administration is not part of the narrower native browser-client surface.
All suffixes also have external-tenant mirrors beneath
`/v1/workspaces/external/:workspaceSource/:workspaceExternalId`, resolving an
existing exact organization identity for the organization service or `asUser`
caller. They do not provision a workspace or bypass operation authority.

Workspace and member writes use compare-and-set:

- `expectedVersion: 0` creates an initial row.
- Every subsequent change or clear names the exact current version, including
  writing `rule: null`.
- Store the returned version. On conflict, refresh the current state and
  reconcile the requested change; never substitute a guessed newer version.
- Clear removes the configured ceiling; it is not a refund, a counter reset,
  or an operation that erases grants and prior accounting.

Clear requires a positive exact version and returns the next lifecycle version.
Store that receipt for later configuration even though the config read becomes
`null`; `0` must not be used to reset the version history.
For example, creation returns version 1, clearing it returns version 2, and
recreation with `expectedVersion: 2` returns version 3. Clear or recreation
with version zero is rejected.

## Member rules are ceilings, not allocations

Set an existing member by its canonical subject ID or external identity:

```ts
const member = { source: "acme-app", externalId: user.id };
const updated = await og.setMemberAllowance(workspaceId, member, {
  rule: { share: 0.25 },
  expectedVersion: 0, // first explicit override for this member
});
// Later, use updated.version, not 0.
await og.setMemberAllowance(workspaceId, member, {
  rule: null,
  expectedVersion: updated.version,
});
```

External identity is `{ source, externalId }`; membership must already exist.
Setting an allowance never onboards or restores a member.

| Rule | Meaning |
| --- | --- |
| `{ share: 0.25 }` | Member ceiling scales with the current workspace pool |
| `{ credits: 20_000_000 }` | Fixed $20 member ceiling |
| `null` | Remove the override and use `memberDefault` |
| Default `"none"` | No separate member ceiling; the workspace ceiling still applies |
| Default `"equal_share"` | Equal shares for eligible current human members |
| Default `{ share }` or `{ credits }` | That rule for each member without an override |

The share base is the **current pool: included credits plus remaining
unexpired grants**. It is not a reserved allocation or the total amount ever
granted. A grant can expand share-based ceilings; consumption and expiry can
change them. A fixed-credit member ceiling does not grow automatically on
top-up.

The workspace meter reconstructs its ceiling as included credits plus grants
consumed in the selected period plus remaining unexpired grants. Already
consumed grant credits therefore stay counted in the workspace's usage/limit
instead of shrinking both sides of the meter. The member share base excludes
those consumed grants. These are intentionally different formulas; do not
derive a member ceiling by multiplying `workspace.limit`.

Shares above `1` and sums above `1` are valid. A share of `1.5` is a member
ceiling, not permission to spend beyond the workspace ceiling. The workspace
still limits aggregate consumption. No member owns an unused slice, and
oversubscribing member ceilings does not create more credits.
An equal-share denominator can change when membership changes. If the product
needs stable per-seat values, use fixed-credit overrides instead.
Eligibility follows active organization membership and workspace membership,
or the canonical Personal-workspace owner pointer. Admitted active external
identities count as humans; API keys and services do not count as seats.
These rules do not broaden the product's organization-workspace provisioning
model or grant Personal workspace access to an organization service key.

## Recipe: a per-seat plan with equal split

Suppose a product includes $20 of OpenGeni credit usage per paid seat, with
five seats in one customer workspace. The product owns the paid-seat count and
billing; OpenGeni owns the settled usage:

```ts
const usdMicrosPerSeat = 20_000_000;
const includedCredits = paidSeats * usdMicrosPerSeat;
if (!Number.isSafeInteger(includedCredits)) throw new Error("Plan amount is too large");

const allowance = await og.setWorkspaceAllowance(workspaceId, {
  includedCredits,
  period: "monthly",
  anchorDay: 1,
  memberDefault: "equal_share",
  expectedVersion: savedAllowanceVersion ?? 0,
});
// Persist allowance.version with the product's plan state.
```

Five eligible members initially get equal ceilings against the $100 pool.
If paid seats and the OpenGeni roster differ, the split follows the roster,
not the paid-seat count. Decide which users are admitted before applying the
recipe; `asUser` and the proxy never create membership.
On a seat-plan change, update the included amount with the saved version.
Do not treat a mid-period config update as a fresh usage period.

For a strict $20-per-user product rule regardless of roster size, use
`memberDefault: { credits: usdMicrosPerSeat }`. This deliberately does not
redistribute unused ceilings or automatically expand them on a grant.

## Recipe: administrator sliders

Build the roster and current rule/version view on a product backend using
`getUsage`. Have an authorized administrator choose relative weights, then
turn those weights into member shares:

```ts
const totalWeight = selectedMembers.reduce((sum, member) => sum + member.weight, 0);
if (!(totalWeight > 0)) throw new Error("Choose at least one positive weight");

for (const member of selectedMembers) {
  await og.setMemberAllowance(workspaceId, member.subjectId, {
    rule: { share: member.weight / totalWeight },
    expectedVersion: member.version,
  });
}
```

Normalization is a product policy, not an API requirement. The API allows
oversubscription. Validate finite nonnegative weights in the backend.
These are separate member writes, not an atomic roster-wide rebalance;
refresh/reconcile conflicts and show partially applied results accurately.
Members absent from the selection keep their existing override or fallback.
Use `rule: null` with the current version to restore the default.

Never forward administrator writes through the conversation proxy or let a
browser choose organization credentials. The backend must authenticate the
administrator and resolve the workspace and member targets.

## Recipe: custom shares and a top-up

A product can let one heavy user consume up to 80% of the pool, two others
up to 40% each, or even assign a share above one. Those overlapping ceilings
are useful when utilization varies; they do not guarantee any user capacity.

For a top-up, persist one product operation ID before making the grant:

```ts
const request = {
  operationId: storedTopUpOperationId,
  credits: 50_000_000, // $50
  expiresAt: null, // no expiry; or an ISO timestamp with an offset
};
const grant = await og.grantWorkspaceCredits(workspaceId, request);
```

Reuse the **same operation ID and exact request** after an uncertain response.
A new ID grants again; the same ID with a different payload conflicts.
Operation IDs are opaque nonblank text, at most 256 UTF-8 bytes.
Omitted `expiresAt` and `null` mean no expiry. Store the returned receipt
alongside the product top-up operation. A payment or invoice belongs to the
product's own billing workflow; an allowance grant is not a Stripe charge or
an organization-credit purchase.

Settled debits consume available included capacity first, then unexpired grants
in earliest-expiry order (nonexpiring grants last). Only the portion actually
covered by a grant reduces its balance; overshoot is still recorded as usage.
Unused unexpired grants are not renewed or erased at a monthly reset.

Only unconsumed, unexpired grant capacity contributes to the current pool.
Share-based rules follow that pool; fixed-credit rules need a separate
versioned adjustment if the product intends to raise them too.
Show an updated usage read rather than adding the grant amount to a cached
progress bar.

## Recipe: one monthly team budget

For a team sharing $500 monthly with no separate user caps:

```ts
await og.setWorkspaceAllowance(workspaceId, {
  includedCredits: 500_000_000,
  period: "monthly",
  anchorDay: 15,
  memberDefault: "none",
  expectedVersion: savedAllowanceVersion ?? 0,
});
```

Everyone draws against the same workspace ceiling. It resets on the UTC
15th, not at midnight in the team's locale. Choose `"equal_share"` or custom
member rules only if the product also wants user ceilings.
For a nonrenewing project budget, use `period: "none"`; the UI must not promise
a future monthly reset.

## Usage reads, history, and resets

Full usage:

```ts
const page = await og.getUsage(workspaceId, {
  period: "current", // default; or "2026-09"
  limit: 100, // 1..200
  cursor: savedCursor, // omit for the first page
});
```

`GET /v1/workspaces/:workspaceId/usage?period=current|YYYY-MM&limit=&cursor=`
returns:

```ts
{
  period: { start: string | null, end: string | null },
  workspace: {
    limit: number | null, used: number, remaining: number | null,
    fraction: number | null, includedCredits: number, grantsRemaining: number,
    status: "ok" | "warning" | "exhausted", resetsAt: string | null
  },
  members: [{
    subjectId: string,
    externalIdentity: { source: string, externalId: string } | null,
    rule: { share: number } | { credits: number } | null,
    version: number,
    limit: number | null, used: number, remaining: number | null,
    fraction: number | null,
    status: "ok" | "warning" | "exhausted", resetsAt: string | null
  }],
  nextCursor: string | null
}
```

Follow `nextCursor` until `null` to build an administrator roster. Keep the
same period while traversing and treat the cursor as opaque.
`rule` is the member override; `null` means fallback, not necessarily unlimited.
Use the computed `limit` and `fraction`, not the override alone.
An unbounded ceiling has nullable `limit`, `remaining`, and `fraction`.
The current projection clamps `remaining` to zero, but does not clamp a
positive-limit `fraction` to one: post-call settlement can expose overshoot.
Use `status` for admission/display state; a zero limit reports `fraction: 1`
and `"exhausted"` even when no usage has been recorded.

`period: "YYYY-MM"` selects a historical allowance window; use its returned
`start`/`end`, particularly with a non-first-day anchor, rather than inventing
calendar bounds. Reads do not execute model work.
Configuration/usage GETs and admission checks have no persisted read-side
effects: they do not create snapshots, counters, notifications, or rollover
jobs. The ordinary API dispatch maintenance loop owns that lifecycle.
For a recorded completed period, the read combines its counters with the
last recorded period configuration, member rules/versions, equal-share
denominator, and grant inventory. Grant expiry is evaluated at that period's
end. Later top-ups must not inflate the historical period. The current named
period remains a live projection; a month with no recorded policy snapshot
is not evidence of a past configured budget.
Member-row discovery and external identity presentation can still reflect
current records, so this is not a per-turn invoice or a complete immutable
historical roster. `YYYY-MM` names the month containing the window's anchor,
not the month of every call in that window. An initially nonrenewing budget
uses one lifetime window. Switching an existing budget to nonrenewing keeps
its existing accounting key; it does not mint a new empty lifetime bucket.
Missing recorded historical policy means unconfigured limits/no fabricated
grant history, not a reconstructed as-of budget.
At a monthly boundary the recurring included allowance renews and a new usage
window begins; settled prior-period usage remains readable. Grant expiry is
separate from the monthly boundary, and a reset is not a refund or a purchase.
Use `resetsAt` from the response. `null` means no reset time is promised.
Settlement time chooses the window and eligible grant pool, not a caller's
backdated event timestamp. A call settling after a boundary is charged to the
new window. Activation does not replay old ledger rows into these counters;
do not promise complete allowance history from before the feature was enabled.

## Recipe: a fraction-only browser meter

The packaged [session proxy](product-integration.md#default-integration-the-full-conversation)
serves **only** `GET /v1/workspaces/:workspaceId/usage/me` for allowance reads.
It resolves the authenticated product user on every request, pins the workspace,
and forwards through `asUser`; there is no service-key fallback or subject
selector. Only `period` is accepted as a usage query parameter. Full roster
reads, configuration, grants, and member mutations are not proxied.

```ts
// Backend: the usual product-authenticated conversation proxy.
const handler = createSessionProxyHandler(og, {
  resolve: async (request) => {
    const me = await authenticate(request);
    return me
      ? { workspaceId: me.openGeniWorkspaceId, user: me.id, source: "acme-app" }
      : new Response("Unauthorized", { status: 401 });
  },
  authorizeMutation: verifyCsrf,
});

// Browser: no OpenGeni key. Use the root SDK client against the proxy.
const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });
const usage = await client.getMyUsage(workspaceId, { period: "current" });
const own = usage.members[0];
const meter = own?.fraction == null
  ? { label: "No individual limit", progress: null }
  : {
      label: `${Math.round(own.fraction * 100)}% used`,
      progress: Math.min(1, own.fraction),
    };
```

Clamp only the visual bar, not the source value or overshoot label. Show
workspace exhaustion separately: an unbounded member can still be blocked by
the workspace ceiling. Refresh after a turn settles and on relevant product
notifications. `/usage/me` uses the same response envelope, but includes only
the authenticated subject's member row, never another member's identity or
usage. It still returns workspace aggregate amounts.

“Fraction-only” is a **presentation** choice: the standard API/proxy response
contains raw USD micros too. If the product requires monetary amounts never to
reach the browser, add an authenticated same-origin product projection that
calls `og.asUser(me.id, { source }).getMyUsage(...)` server-side and returns
only the approved fraction/status/reset fields. Do not claim the packaged
proxy redacts amounts.

## Attribution and background work

The initiating human is frozen at accepted-work boundaries, not inferred from
the current viewer or session creator:

- Direct external-user work uses the canonical subject established by
  `asUser(authenticatedUser, { source })`.
- Service work with no verified initiating member consumes only the workspace
  ceiling; it does not borrow the creator's or an administrator's member cap.
- A schedule accepted for a member retains its frozen initiating member;
  generated occurrences must not change payer attribution to whoever later
  views or edits the session.
- Child work and goal continuations inherit their causal initiating member.
  They do not gain a fresh member pool merely by creating a new session or
  physical attempt.
- Recovery preserves accepted attribution. Editing session metadata, an
  external end-user label, or an MCP `_meta` field cannot select a different
  allowance subject.

This applies to non-model debits too:

- Paid Knowledge queries use the exact turn's frozen human or a verified
  direct human request; key/service requests remain workspace-only.
- Paid indexing retains the revision/job's enqueue attribution, including a
  scheduled source's accepted causal human. A new direct upload records its
  verified request attribution before asynchronous work begins.
- Warm-compute charges retain attribution frozen at the cold-to-warming
  lease epoch. Heartbeats, reapers, and final-stop settlement reuse it;
  the observer or latest session creator is never a replacement payer.
- Legacy paid work with unknown attribution can be deferred/refused with an
  attribution-unavailable outcome rather than silently charged as service
  work. Do not claim every old job or lease can be resumed automatically.
- Managed video preserves its existing prepaid debit lifecycle, with exact
  initiating-turn attribution; it is not a new allowance reservation API.
  A matching refund reverses the original recorded workspace/member usage,
  included-credit consumption, and exact grant allocations once, in the
  original period. It does not transfer that usage into a later month or
  restore another member's allocation. Restored expired grants remain
  unusable in current admission. A legacy debit with no allocation receipt
  cannot have an allowance reversal fabricated from usage totals.

Native image/model credit charges use ordinary model accounting. Externally
funded adapters without a negative OpenGeni ledger entry and transcription
without a ledger debit do not consume allowance.

Keep schedule time zones separate from allowance UTC boundaries. See
[run lifecycle](run-lifecycle.md), [scheduled task access](scheduled-task-access.md),
and [workspace integrations](workspace-integrations.md) for the surrounding
execution and informational MCP identity contracts.

## Errors and event handling

The typed SDK error `OpenGeniAllowanceExhaustedError` has
`code: "allowance_exhausted"`, `scope: "workspace" | "member"`,
`resetsAt: string | null`, and an optional `subjectId`. It is not an automatic
transport retry. Show the affected scope and offer an authorized plan change,
grant, or reset/recheck path; a fixed member ceiling may still block work after
a workspace top-up.

Worker admission can refuse previously accepted work asynchronously. A
successful Send or session-create response is not proof that a model call ran.
Read durable session state/events to distinguish allowance admission failure
from provider-capacity waits, organization-credit exhaustion, and ordinary
authorization failures. Do not resend an accepted prompt merely because the
next call was refused.

The worker emits session `usage.exhausted` with the typed refusal, completes
the turn segment with `segmentLimit: "budget_exhausted"`, leaves the session
idle and resumable, and pauses an active goal with the refusal rationale.
It preserves conversation/run state for later work instead of declaring a
provider failure. An authorized grant or monthly reset changes capacity, not
the user's pause/goal intent; resume the desired work explicitly.

Configuration/member version conflicts and changed grant replays return HTTP
409; missing targets return 404 and unauthorized operations 403. Invalid
request bodies/queries return 400. Distinguish these from
`allowance_exhausted`, and retain request/correlation information when available.
Never replay a mutation automatically after an unknown transport outcome.

The public workspace webhook types include:

- `usage.threshold_reached`
- `usage.exhausted`
- `usage.period_reset`

Their envelope is workspace-scoped: `{ id, type, workspaceId, occurredAt,
data }`. `sessionId` and `turnId` may be omitted or `null`, and `sequence` is
optional, not a session replay cursor. `data.scope` distinguishes
workspace/member when present; `data.subjectId` may be nullable and
`data.period` may be an anchor-month string or a `{ start, end }` window.
Do not invent a session ID or a session-wide ordering guarantee for these
notifications.
Treat each as an invalidation and perform a fresh authorized usage read.
Verify signatures with `verifyWebhookEvent`, deduplicate by event `id`, and
allow unordered, at-least-once delivery using the existing
[workspace webhook protocol](workspace-integrations.md#webhooks).

Periodic allowance maintenance evaluates threshold/exhaustion notices from
settled counters, current policy, membership, and grant expiry. It runs in the
existing API workspace-webhook dispatch loop, independently of inference,
usage GETs, pending deliveries, and webhook-secret availability. Notices are
deduplicated by workspace, period, member/scope, and threshold. The exhaustion
threshold `1` is evaluated even
if omitted from custom warning lists; it can produce both `usage.exhausted`
and a `usage.threshold_reached` signal with separate event IDs. Do not assume
one notice per model call, or a second warning after a grant lowers the
fraction and it crosses the same threshold again in that period.

The bounded maintenance sweep handles idle rollover and expired grants without
a user opening the product. It processes up to 20 due workspaces and 100
members per workspace page by default, normally scheduling the next sweep
after one minute and continued member pages sooner. `usage.period_reset`
follows observation/closure of the prior window, not a callback guaranteed
at the exact UTC boundary. Large backlogs or unavailable API dispatchers can
delay it. Usage GETs, including historical reads, never enqueue resets.

Notification receipt/outbox enqueue is transactional within maintenance.
Failures record a maintenance error and schedule retry; they are not silently
treated as completed warning evaluation and do not roll back an earlier
authoritative debit. Once enqueued, delivery uses the normal durable webhook
outbox. Keep API dispatchers running even when workspaces are idle.
Subscribing after a threshold has already been observed does not promise
historical notification replay. A usage read remains the source for the
current meter; verify deployed dispatch and emission separately from the type
list.

## Integration checks

Before shipping a product plan:

- Confirm the installed SDK and deployment expose the allowance methods and
  agree on USD-micro units.
- Verify CAS conflict handling, an exact replayed grant, external-member
  targeting, and `null` fallback.
- Check UTC month-end anchoring, grant expiry, historical reads, and an
  unbounded/nonrenewing response.
- Exercise one-call and parallel-call overshoot; preserve read access and show
  the correct exhausted scope.
- Verify service, scheduled, child, continuation, and externally funded
  attribution with actual settled debits.
- Check that the proxy rejects full usage and every allowance mutation, that
  `/usage/me` cannot select another subject, and that any fraction-only
  projection strips raw amounts if required.
- Verify actual webhook emission separately from subscription/type support.

Do not substitute these allowance counters for a product invoice or promise a
hard prepaid reservation guarantee.