# Usage allowances in a product integration

Use when the product sells included usage, per-seat plans, team budgets,
administrator splits, or top-ups. With the repository available, read
`docs/usage-allowances.md` for complete recipes and
`docs/product-integration.md` for the organization-key/user boundary.
Verify installed SDK types and deployed routes before using these primitives.

`OPENGENI_USAGE_ALLOWANCES_ENABLED` defaults false for rolling admission.
Upgrade all API/control/turn consumers before enabling new config/grant/rule
writes. Reads and enforcement of persisted policies do not depend on this
producer flag; disabling it is not an allowance bypass or permission to run
old readers.
Disabled producers return 409 for config/grants/non-null member rules;
authorized versioned clear and `rule: null` recovery remain available.

## Choose the product policy

- Per-seat plan: the backend computes included USD micros from paid seats;
  `memberDefault: "equal_share"` splits by eligible current OpenGeni members,
  not the product's paid-seat count.
- Stable user caps: use `{ credits }`; roster changes and workspace grants do
  not automatically expand a fixed member ceiling.
- Team budget: `"monthly"` with default `"none"` gives one workspace ceiling
  and no separate member cap. `"none"` as the period is a nonrenewing budget.
- Administrator sliders: turn authenticated choices into `{ share }` rules
  with exact member versions. Normalizing the sum is product policy; writes
  are per-member, not an atomic roster-wide rebalance.
- Custom shares/top-ups: shares may exceed one or sum above one. They are
  ceilings, never reserved allocations or guaranteed access to capacity.

Amounts are integer USD micros: 1 USD = 1,000,000. Do not use floating dollars,
tokens, or estimated provider expense as allowance amounts.
The configuration is `{ includedCredits, period: "monthly" | "none",
anchorDay?: 1..31, memberDefault?: "none" | "equal_share" | { share } | { credits },
thresholds?: { workspace?: number[], member?: number[] } }`.
Monthly boundaries are UTC, with anchors clamped to each month's last day;
omitted threshold lists default to `[0.8, 1]`.
Each threshold list accepts at most 16 positive fractions up to one.
Anchor edits retain active-window usage until its boundary. Switching to
nonrenewing preserves the accounting key/usage and removes the reset time;
switching back preserves usage and sets a monthly boundary. Use returned
windows rather than computing them from the new config.
Equal shares count canonical eligible humans, including active admitted
external identities and the Personal-workspace owner, never keys/services.

## SDK and authority

The root `OpenGeniClient` provides:

- `getWorkspaceAllowance(workspaceId)`
- `setWorkspaceAllowance(workspaceId, { ...config, expectedVersion })`
- `clearWorkspaceAllowance(workspaceId, { expectedVersion })`
- `getWorkspaceAllowanceState(workspaceId)` returns `{ version, config }`,
  including a cleared lifecycle's version.
- `grantWorkspaceCredits(workspaceId, { operationId, credits, expiresAt? })`
- `setMemberAllowance(workspaceId, subjectId | { source, externalId },
  { rule: { share } | { credits } | null, expectedVersion })`
- `getUsage(workspaceId, { period?: "current" | "YYYY-MM", limit?, cursor? })`
- `getMyUsage(workspaceId, { period?: "current" | "YYYY-MM" })`

Workspace config/grants require a full-access organization key with literal
`api_keys:manage` or verified human `account:admin`; workspace administrators
cannot raise or clear the budget. Human organization budget administration
does not require membership in the target shared workspace, but grants no
operational access or full usage roster.
Member splits require verified human workspace administration or a full
organization key; account-admin-only, workspace-key, and service callers cannot
write them. **All reads and writes refuse agents.** Build authenticated backend/admin flows,
not agent tools that adjust the agent's own spending ceiling.
Membership must already exist; assigning a rule never grants access.

`expectedVersion: 0` means initial creation, exact versions thereafter.
Store returned versions; refresh/reconcile conflicts rather than guessing.
Member `null` restores the workspace default and is itself versioned.
Clear requires an exact positive version and returns `{ version }`. Supply an
`operationId` and reuse the exact request after a lost response. The replay
rechecks authority and conflicts after a later lifecycle change; read
`getWorkspaceAllowanceState` to reconcile without guessing a version.
The existing configuration read still returns null after clear.
Recreation requires that exact clear version; zero is rejected after any
configuration has existed, including after clear.

Allowance refusals identify `scope` and `resetsAt`. A workspace ceiling is
raised by an organization administrator/full organization key; a member
ceiling is adjusted by a workspace administrator/full organization key.
Buying organization credits or connecting a subscription does not by itself
raise an exhausted allowance. Web, MCP, and Slack retain this distinction.
Reuse the grant's operation ID and exact body after an uncertain result; a
new ID grants again and a changed body under the same ID conflicts.
Omitted/null expiry means no expiry. A grant increases allowance capacity,
not the organization's purchased-credit balance.
The grant receipt is `{ operationId, credits, remaining, expiresAt }`;
operation IDs are nonblank opaque text bounded to 256 UTF-8 bytes.

## Meter and browser boundary

Usage returns `{ period: { start, end }, workspace, members, nextCursor }`.
Workspace/member rows include `limit`, `used`, `remaining`, `fraction`,
`status: "ok" | "warning" | "exhausted"`, and `resetsAt`; workspace also has
`includedCredits`/`grantsRemaining`, members have subject/external identity,
override `rule`, and `version`. Use returned bounds and computed limits.
Nullable limits/fractions mean unbounded; remaining clamps to zero and
positive-limit fraction can exceed one after settlement. Zero limits report
fraction one and exhausted status even with no recorded usage.
GETs/admission checks are read-only; periodic API maintenance owns snapshots,
rollover, and notification evaluation.

For the normal browser conversation, use the packaged session proxy and
`client.getMyUsage(...)`. It exposes only `GET /usage/me`, only a `period`
query, and the resolved authenticated user's row through `asUser`. It refuses
full roster/config/grant/member routes and has no service-key fallback.
Render `fraction` instead of raw USD micros; clamp the bar, not the underlying
percentage. The response still contains raw amounts and workspace aggregates:
if those must never reach the browser, provide a same-origin authenticated
server projection returning only allowed fraction/status/reset fields.
Keep the organization key on the backend.

React hosts can use `@opengeni/react/usage` instead of hand-building this:
`useUsage`/`<UsageMeter>` read `/usage/me` (shares only unless the host passes
`formatAmount`), `<UsageLimitNotice>` is the composer's near/at-limit line
(`labels` and `action` let the host name its own remedy, such as "Upgrade"),
and `<UsageMemberList>` is an admin roster with a share slider whose
`onChangeRule` must call the host backend (never the proxy). The timeline's
"usage limit reached" row takes `allowanceExhaustedLabels` or
`renderAllowanceExhausted` on `SessionConversation`/`MessageTimeline`.
Browser code with only the narrow client uses `@opengeni/sdk/usage-allowances`
free functions over `requestJson`.

Share-based ceilings use included credits plus **remaining unexpired grants**,
so they vary with grants, consumption, expiry, and membership. They are not a
promise of a fixed monthly slice.
The workspace meter includes consumed grants from the selected period as well
as remaining grants; the member share base does not. Do not compute member
limits from `workspace.limit`.

## Settlement, attribution, and notifications

Only actual OpenGeni credit debits consume allowance. Externally funded
subscription/BYOK work without such a debit is exempt, not necessarily free
upstream. No reservation occurs: a call may overshoot, concurrent calls may
overshoot together, and the next admission is blocked. Reads remain authorized.
Service work without a verified initiating member uses the workspace ceiling
only. Member schedules, children, goal continuations, and recovery retain their
frozen causal initiating member, never a viewer or guessed session creator.

`OpenGeniAllowanceExhaustedError` carries `code: "allowance_exhausted"`,
`scope`, `resetsAt`, and optional `subjectId`; it is not an automatic retry.
Accepted messages can encounter asynchronous worker admission refusal; inspect
session state/events rather than resending a prompt.
Session `usage.exhausted` completes a budget-limited turn segment, leaves the
session idle/resumable, and pauses an active goal. A grant/reset is not an
automatic goal resume. Version/grant conflicts return 409; missing targets
404, unauthorized operations 403, invalid requests 400.
Historical `YYYY-MM` reads select anchor-month counters and the recorded
period configuration/rules/denominator/grant inventory, with expiry evaluated
at period end. Current named periods remain live; identities/row discovery
can still reflect current records, so this is not a complete historical roster.
Settlement time chooses the window; activation does not backfill earlier
ledger usage. Included capacity is spent first, then grants earliest-expiry
first; unused unexpired grants survive a monthly reset. Clearing config is
not a refund or history reset.
Paid Knowledge queries/indexing and warm-compute debits also retain exact
turn/request/enqueue/lease-epoch attribution; observers and creators do not
replace it. Legacy unknown paid attribution can defer/refuse work rather
than silently charge a service. Managed video retains prepaid billing;
matching refunds reverse the original period's recorded usage and exact
included/grant/member allocations once. Expired restored grants stay unusable;
legacy debits without allocation receipts do not get invented reversals.

The public webhook types are `usage.threshold_reached`,
`usage.exhausted`, and `usage.period_reset`; usage envelopes omit or null
session/turn IDs, have an optional sequence, and carry workspace/member scope
when present. Verify actual deployed
emission and reset timing, not only the type list. Verify signatures with
`verifyWebhookEvent`, dedupe by ID, tolerate unordered at-least-once delivery,
and reread usage after a notification. See `docs/workspace-integrations.md`.
Periodic maintenance in the API webhook-dispatch loop evaluates deduplicated
per-period/member thresholds, idle rollover, and expiry without usage readers
or inference. The exhaustion threshold is always evaluated. Sweeps are bounded
to 20 workspaces/100 members per page by default, normally one minute apart;
reset delivery is not guaranteed at the exact UTC boundary. GETs never enqueue
events. Receipt/outbox enqueue is transactional; maintenance failures are
recorded/retried without reversing earlier debits. Late subscribers are not
guaranteed past threshold replay.

Verify CAS/replayed grants, UTC month-end windows, fallback rules, expiry,
history, overshoot, frozen attribution, external funding, proxy rejection, and
real webhook emission before presenting a plan as enforced.