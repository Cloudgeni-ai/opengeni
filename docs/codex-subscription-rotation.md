# Codex subscription rotation

This is the canonical contract for selecting, leasing, refreshing, and failing
over ChatGPT/Codex subscription credentials. The implementation sources are
`apps/worker/src/activities/agent-turn/codex-capacity.ts`,
`apps/worker/src/activities/codex-rotation.ts`, and the Codex accessors in
`packages/db/src/index.ts`.

## Security and scope

The **effective credential pool is the complete scheduling boundary**.

- Personal workspaces always use their own workspace pool.
- Shared workspaces choose one source: `automatic`, `workspace`, `organization`,
  or `disabled`. `automatic` uses a workspace pool when any local credential is
  connected, otherwise it inherits the organization pool. The allocator never
  union-ranks organization and workspace credentials.
- Organization credentials have one encrypted row, usage snapshot, cooldown,
  fairness cursor, and organization rotation row across every inheriting shared
  workspace. New shared workspaces therefore inherit an already-connected pool
  without copying or reconnecting credentials.
- Session pins, last-used pointers, capacity waiters, and lease rows remain in
  the target workspace. Schema guards accept an organization credential only
  while that shared workspace's effective source is `organization`.
- Workspace-local duplicate connections remain independent. OpenGeni does not
  correlate a ChatGPT account connected separately in multiple workspace pools
  or across managed organizations.
- Organization rows are visible at management time only to active organization
  owners/admins using a managed-cookie session, and at runtime only from shared
  workspaces in the same organization. Personal workspaces cannot inherit them.

This preserves workspace session isolation while making provider quota,
refresh, health, cooldown, and cumulative fairness truthful for the one shared
organization credential row.

## Atomic selection and fairness

Every Codex turn calls `acquireCodexCredentialLease` before model/tool
preparation. Leasing is execution ownership, not a rotation feature flag:

1. Start one RLS-scoped Postgres transaction, resolve the workspace's effective
   source, and materialize/lock its serialization row with `FOR UPDATE`:
   `codex_rotation_settings` for a workspace pool or
   `organization_codex_rotation_settings` for an organization pool. Concurrent
   replicas using the same pool wait; they do not `SKIP LOCKED`.
2. Lock the durable turn for update and verify it belongs to the exact
   account/workspace. If a downstream policy supplies an opaque accepted-turn
   scope resolver, resolve it from that locked turn metadata while the rotation
   transaction remains held. A present
   `codexCredentialPolicySnapshotV1` is the accepted allocator policy for this
   logical turn; malformed present metadata fails closed.
3. Reap expired leases for the target workspace and read every credential in
   the one effective pool. Organization decisions share the organization lock
   and cumulative selection cursor across workspaces.
4. Offer an exact live same-turn lease to the pure strategy against the complete
   pool rows. A saved approval RunState does not own a credential. Only if this is a new
   allocation may an optional downstream policy filter the candidate rows. Run
   the strategy and revalidate its chosen id against that resulting set.
5. Upsert the unique `(workspace_id, turn_id)` lease and increment the selected
   credential's server-held fairness cursor. The active pointer advances
   in the same transaction only when the selector allows it; manual pins and
   sharded policy homes explicitly veto pointer movement.

The Codex worker holder is execution-unique: it includes the workflow run,
durable turn-attempt UUID, dispatch id, and Temporal's server-assigned activity
execution identity. `generation` is an additional in-row replacement fence,
not the sole owner identity. Expired rows may be reaped before a successor
acquires the same turn and starts at generation `1`; the successor still cannot
be touched by a stale worker because heartbeat, release, quarantine, and
settlement all carry the non-reused holder identity.

6. On the first allocator decision, write the bounded accepted allocator policy
   snapshot to the locked turn row in the same transaction, even when the
   decision has no credential and the caller must enter a capacity wait. New
   snapshots include the effective `workspace`, `organization`, or `disabled`
   source because it selects the allocator pool. Re-acquisition and
   definitive-failure settlement reuse its active pointer, rotation state,
   effective strategy, source, and session pin/last-used state while re-reading
   current account health and cooldowns. Later workspace/session policy changes
   therefore do not change the constraints of an already accepted logical turn.
   Pre-source snapshots remain readable and use their historical live-source
   behavior; all newly accepted turns persist the source explicitly.

Stored legacy strategy values are normalized at every worker read to the
effective `sharded` behavior. The old column values and API input compatibility
remain for rollback/read compatibility, but `most_remaining`, `round_robin`,
and `drain_then_next` are no longer distinct runtime strategies.

`most_remaining` ranks eligible credentials by:

1. fewest active DB leases;
2. most remaining capacity across the binding five-hour/weekly windows;
3. fewest prior selections;
4. least-recent selection, then stable creation/id order.

The first and third/fourth inputs are server-held. Provider usage headers improve
capacity ranking but are **never the sole atomic allocator**. Consequently a
burst sees earlier reservations and spreads before delayed usage headers move.

Usage percentages never create a configurable "near exhaustion" cliff. Accounts
remain eligible through 99% in either provider window; 90% is presentation-only
warning state. Cached usage excludes an account only at 100%, while an explicit
provider refusal installs the authoritative cooldown. A later live usage read
may reconcile an older quota cooldown only when the provider reports an open
base allowance, every surfaced feature-specific window is below exhaustion,
and the cooldown revision proves no newer refusal raced the read. Generic
provider backpressure is never cleared by quota telemetry. Sharded policy pins remain
sticky throughout 90–99% and are rewritten only after actual exhaustion or another
definitive health failure.

The effective pool's active credential is a cursor, not a sticky lease. Pin source is
load-bearing: a `manual` (or defensively unlabeled) pin is user intent and never
silently fails over; if it is capped, the turn enters the same durable capacity
wait. A `policy` pin is a sharded cache-affinity home and may be re-sharded over
eligible candidates when that home caps. Policy pin writes use an observed-state
CAS inside the rotation-row-first capacity-mutation transaction, so a stale
sharding decision cannot overwrite a concurrent manual pin. Policy pins are
ignored and lazily cleared outside the active `sharded` strategy. A live
same-turn lease is reused before either pin policy or future membership
filtering, so cache policy never moves in-flight work. With
`rotation_enabled=false`, new allocations may use only the active account; if
that account is capped or cooling, the same turn enters durable capacity wait
even when another account is healthy. With `rotation_enabled=true`, eligible
alternates may serve a new or recovered turn.

Named pool membership is intentionally not a credential allocator concept. The generic
`CodexCredentialLeasePolicyScopeResolver<TPolicyScope>`,
`CodexCredentialLeaseCandidateFilter<TPolicyScope, TUnavailableDiagnostic>`,
and `CodexCredentialLeaseCandidateFilterResult<TUnavailableDiagnostic>` seams
let a downstream accepted-turn policy pass a private scope such as
`{primaryPoolId,fallbackPoolIds,policyHash}` into the existing rotation-row
transaction. The filter chooses candidates from exactly one resolved primary or
fallback scope and may return downstream-owned per-pool unavailable/reset
diagnostics; credential allocator never union-ranks memberships and stores no pool table or
membership rule. `CodexCredentialLeaseResult<T, TUnavailableDiagnostic>` returns
those diagnostics. The new-allocation filter runs only after exact live
same-turn reuse, so a later membership/default change cannot move an already
accepted holder.

## Public status semantics

`GET /v1/workspaces/:id/codex/status` keeps the backward-compatible
`activeAccount` and `valid` fields. `valid` is a live model-catalog probe of the
active account only; it is not a readiness claim about every connected account.
The additive `activeAccountValid` field names that scope explicitly.

`poolReady` is metadata-only cached readiness: at least one account in the
effective pool is active, allocator-enabled, outside a current cooldown, and
below cached 100% exhaustion in both windows. `workerRoutable` applies the
current rotation rule to that same cached view: rotation on can route an
unpinned turn to any ready pool account, while rotation off can route only to
the active pointer. Manual session pins remain session-specific and are not
represented by this workspace-level boolean. Both fields can become stale
between reads; they describe worker admission inputs, while `valid` describes
the separate active-account probe.

`codex_subscription_credentials.allocator_enabled` is a separate, additive
new-allocation gate (default `true`); it is not credential health. Setting it
false excludes the row from new automatic, pinned, proactive, and reactive
selection without changing `status`, encrypted credentials, refresh behavior,
or quota history. An exact same-turn live lease may continue on that healthy
row; reconnect and token refresh never
flip allocator eligibility. account eligibility policy owns toggle OCC/audit and product controls.

## Quota overview, allocator control, and reset-credit redemption

Codex quota adds three deliberately separate product seams:

- **Overview reads** fetch `/wham/usage` and the detailed reset-credit inventory
  independently for each workspace credential, with at most four provider calls in
  flight and a bounded whole-route deadline. Every result names its provider/cache
  source, timestamp, staleness, error and
  typed detail authority (`detailed`, `count_only`, `capped`, `unsupported`,
  `unknown`, or `error`). `available_count` is cached as summary metadata;
  detailed opaque ids are never cached as activation authority. Missing/capped
  detail, unknown enums, expired/non-available rows, and summary disagreement are
  view-only. Valid quota windows advance `usage_checked_at` independently from
  valid reset-summary data advancing `reset_credits_checked_at`; a malformed or
  timed-out reset inventory cannot erase fresh five-hour/weekly provider truth.
  An authoritative open response also clears the exact older typed quota
  cooldown observed before provider I/O. The revision makes a concurrent newer
  refusal win; legacy-unknown and generic rate-limit cooldowns remain intact.
  All-capped turn admission refreshes those typed quota cooldowns immediately;
  a durable wait then retries the control-plane read with bounded backoff so an
  already-waiting turn also notices an allowance cycle replaced before reset.
- **Allocator control** writes only `allocator_enabled` plus its independent
  `allocator_version`/actor/timestamp. Same desired state is idempotent even with
  a stale expected version; a conflicting stale transition returns the current
  version. One real change and one audit row share a transaction. Credential
  token `version`, health, connection, cooldown, quota history, active leases,
  and accepted turns remain independent; reconnect, refresh and redemption never
  auto-enable the row.
- **Reset redemption** has no SDK method, MCP/Codemode tool, worker activity,
  scheduled/background hook, or allocator/rotation call. Its REST mutation
  requires managed product mode, an actual Better Auth cookie with no
  `Authorization` header, workspace admin, the exact `user:<id>` who most
  recently connected the credential through a direct cookie session, exact
  same-origin `Origin`, `Sec-Fetch-Site: same-origin`, and a five-minute
  session-bound HMAC confirmation. The deployment must configure
  `publicBaseUrl`; the route never derives a trusted origin from request
  `Host`/URL headers. Legacy/nonhuman-connected rows are view-only.
  The overview returns only a closed, secret-free ownership reason. A legacy
  row with no recorded human owner explicitly tells an eligible direct
  managed-cookie admin to reconnect the same ChatGPT account; that row-locked
  same-provider upsert may fill only a NULL owner. A different existing owner
  is never transferred by reconnect, and disconnect remains the explicit
  ownership-reset boundary. When no matching managed human can be verified, the
  browser renders a closed view-only explanation with no reclaim action. The
  browser refreshes the full overview after a successful reconnect so an exact
  claim immediately exposes Redeem.

The durable redemption attempt separates `processing` (fresh exact actionable
detail still owed) from `provider_started` (the consume POST may have begun).
The browser supplies one stable logical UUID; the server creates one upstream
idempotency key. Immediately before every consume POST, including a recovery
retry, a DB-time fence locks and revalidates the credential owner/health, exact
browser claim, live claim lease, and unexpired confirmation, then atomically
records `provider_started`. A crash before `provider_started` re-fetches detail. Any
timeout/network/invalid response after `provider_started` preserves that state
and retries with the same upstream key even if inventory has since changed;
`alreadyRedeemed` resolves the ambiguity as success. Concurrent claims return
in-progress. Unresolved `provider_started` work blocks credential disconnect and
ownership-changing reconnect so its only durable provider key cannot be
orphaned; a same-owner browser-session rotation can discover the attempt in the
owner-scoped overview and explicitly adopt it. Browser `sessionStorage` retains
only optional title/expiry convenience and is never recovery authority.

Exact `reset`, `nothingToReset`, `noCredit`, or `alreadyRedeemed` outcomes are
persisted and audited once. The redeem response returns that durable outcome
with `overview: null` and never waits for provider usage/detail readback; the
browser refreshes the independently bounded overview afterward. A completed
outcome remains server-discoverable after tab/session loss or later credential
health changes. `reset`/`alreadyRedeemed` permanently suppress another consume
for that provider credit. `nothingToReset`/`noCredit` remain visible as history
but do not suppress a later newly confirmed attempt when the provider again
reports exact actionable detail; that later action receives a fresh logical and
upstream idempotency key.
`reset`/`alreadyRedeemed` clear provider-exhaustion cooldown without usage
readback; an independently fresh open usage response may also reconcile an
older typed quota cooldown through the revision fence above. No redemption
outcome changes allocator eligibility. The one-credit fence remains permanent only for
those successful outcomes; `nothingToReset`/`noCredit` permit a later, newly
confirmed logical attempt. Provider bodies, bearer tokens, opaque credit ids and
upstream keys never enter logs/events/audit metadata.

Migration `0065_codex_subscription_overview.sql` is a maintenance cutover, not a
rolling API change. Every old API replica must be drained before applying it,
because old binaries neither record the connecting human nor protect unresolved
provider attempts from disconnect/ownership-changing reconnect. Start only the
new revision after the migration; mixed old/new API writers are forbidden.

The unique same-turn lease is idempotent. A one-minute heartbeat renews its
five-minute TTL throughout long tool/model runs; normal completion releases it
idempotently. The worker advances a conservative monotonic ownership deadline
only after Postgres confirms acquisition/renewal, so a hung or repeatedly failing
heartbeat cannot carry model progress beyond the last proven TTL. A killed worker
stops renewing, and expiry lets a successor turn reclaim capacity. If a live
activity discovers that its lease was lost, a
holder/generation plus worker-redispatch-fenced transaction either requeues that
still-current turn from its durable checkpoint or treats the activity as stale;
it never falls through to an unfenced terminal write. Credential leases do not
serialize inference: they are load signals used to spread concurrent turns, not
exclusive locks on an account.
Immediately before the first provider request, the worker also requires a held
lease with a non-expired confirmed deadline. A missing or expired deadline is
marked lost before provider I/O and enters that same lease-loss settlement path;
it is never treated as a generic provider failure.

## Reset and failure semantics

Both the five-hour and weekly allowance windows bind. A cached capped window whose
provider reset timestamp has elapsed becomes eligible immediately; an all-capped
pool performs one bounded live usage refresh before idling. Unknown reset data
always yields a positive bounded delay, never a zero-delay loop.

If no healthy candidate exists for the currently admitted Codex turn,
`armCodexCapacityWait` atomically closes its exact attempt with outcome
`waiting_capacity`, releases the exact credential lease when reactively armed,
preserves the same nonterminal blocked turn plus the session's active-turn
pointer, writes the audit events, and creates or advances one
`codex_capacity_waiters` row. This applies to goal-bearing and goalless prompts.
The arming lock order is workspace rotation row →
`workspace_inference_controls FOR SHARE` → actual workspace `FOR KEY SHARE` →
session → exact turn → exact attempt → optional goal → live credential lease
(when reactive) → waiter. Arming re-evaluates effective control under that
shared control lock and becomes an event-free stale no-op if Pause or an
unsettled control interruption won. A reactive arm must still own the exact
holder/generation and worker-redispatch fence. The row records the blocked turn
generation, an optional active-goal id/version fence, accepted `policyHash`, the
earliest authoritative reset (when known), bounded-refresh state, and
`wakeRevision`/`observedWakeRevision`; it stores no credential material or
provider body. Every worker arm site immediately runs one allocator
reconciliation before returning the waiter to the workflow. That closes the
mutation-before-insert edge: a rotation/account change that committed just
before the waiter existed is observed under the allocator lock, while any
later change advances the waiter's durable wake revision normally.

`reconcileCodexCapacityWait` runs the normal metadata-only allocator decision
under the same rotation-row transaction. It accepts the same opaque
accepted-turn scope resolver/new-allocation filter as acquisition, so a named
pool policy can return per-pool diagnostics without union ranking or duplicating
the waiter. Unavailable decisions return `earliestResetAt`, `resetKind`
(`authoritative`, `bounded_refresh`, or `mutation_only`), and optional
secret-safe diagnostics. `mutation_only` is used when capacity can change only
through a control-plane mutation such as reconnect, re-enabling an allocator,
changing a pin, or restoring a missing active pointer; it never schedules a
provider-reset-only wake.
Unknown resets exponentially back off from one to fifteen minutes without
running a model. Availability atomically marks the waiter resumed and moves the
exact blocked turn and session from `waiting_capacity` to `recovering`, keeping
the same turn id and active pointer. The workflow's ordinary admission path
then creates a new attempt for that turn. It creates no `user.message`, system
update, usage event, goal continuation, or queued turn, and it does not perform
a competing terminal settlement/requeue. A second timer/signal observes the
waiter as resumed/stale and performs no work.

`withCodexCapacityMutation` is the same-transaction mutation/outbox seam for any
eligibility or future pool membership/default write: it locks the effective
workspace or organization rotation row first, applies the mutation, increments matching waiter wake
revisions only when truth changed, and returns secret-safe signal targets.
Refreshing only `usage_checked_at` or reset-credit display metadata is not a
capacity-truth change; clearing a future typed quota cooldown is. An identical
quota snapshot that leaves cooldown state unchanged must not advance waiter or
workflow wake revisions. With rotation disabled, an unpinned turn considers only
the workspace active pointer: a capped pointer enters the same durable wait and
never becomes “available” merely because it remains connected, while healthy
alternate subscriptions remain unused until rotation is explicitly enabled.
`listPendingCodexCapacityWakeTargets` repairs commit→signal loss. The session
workflow's `codexCapacityChanged` signal is only a nudge; the Postgres revision
is authoritative. The workflow snapshots its wake counters before dispatching a
turn, so a signal delivered after waiter commit but before the activity result
returns causes immediate reconciliation instead of being baselined away. It
reconstructs pending timers on worker/Temporal restart and `continueAsNew`.
`reconcileCodexCapacityWait` takes the same rotation/control/workspace prefix
and atomically rechecks effective Pause, optional goal, accepted policy, active
pointer, blocked-turn generation, and duplicate-work fences before the
same-turn `recovering` transition; ordinary queued prompts remain behind that
current turn, and ordinary attempt claim repeats admission before
provider/model/tool/billing work starts. Pause returns without mutating the
waiter so Resume can reconstruct it. Steer, cancellation, or another semantic
fence change supersedes the waiter/blocked turn rather than letting a stale wake
run. Reset/boost entitlement redemption is never automatic.

Only a **definitive credential/account refusal** can move the same durable turn to
another credential:

| Failure | State transition | Automatic credential failover |
| --- | --- | --- |
| First 401 | One forced token refresh and one request retry under a DB refresh lock | Not yet |
| Second 401 | Credential `needs_relogin` | Yes, if another eligible credential exists |
| 403 | Credential `error` | Yes, if another eligible credential exists |
| `usage_limit_reached` / explicit quota | Cooldown to the latest still-binding reset, or one five-hour fallback | Yes |
| Other 429 / explicit rate-limit code | Provider retry-after, or bounded backpressure cooldown | Yes |
| Network break, 5xx, invalid content, malformed/partial 200 stream | No credential quarantine | **No** |

Before definitive failover, the worker flushes streamed events and reconciles
attempt-fenced `session_history_items`, then quarantines status/cooldown only
through the exact live credential holder/generation. One transaction closes the
first-class turn attempt as recoverable, closes ambiguous in-flight tool calls
as `interrupted / outcome unknown`, increments a persisted per-turn failover
counter, emits `turn.recovery.requested`, and leaves the **same logical turn** in
`recovering`. It creates no prompt queue row or synthetic user/resume message.
The next attempt reconstructs durable model history and tool lineage. This is an
explicit checkpoint/resume, not a Temporal or SDK blind retry. The counter is
bounded by the enabled-alternate count frozen by the first accepted failover, so
later pool shrink cannot strand an originally permitted alternate and later pool
growth cannot add attempts. A malformed classification therefore cannot walk
forever; a stale holder cannot quarantine a credential or settle the turn.
Reaching the bound is a terminal result for that accepted turn and explicitly suppresses an active
goal's autonomous continuation wake. The goal row fences that suppression to
the exact exhausted turn; evaluation and invariant repair keep unchanged input
inert, while a later human, API, machine-input, or goal mutation becomes newer
truth and proceeds normally. Another synthesized turn therefore cannot reset
the per-turn counter without new external work.

If no alternate is eligible, or rotation/manual-pin policy forbids leaving the
selected account, the quarantined holder arms the same durable capacity waiter
used by proactive admission. Quota/rate-limit cooldowns, reconnects, status
repairs, allocator changes, and rotation-policy changes wake that exact turn.
An auth/forbidden refusal is terminal only when the pool is truly empty or has
no allocatable account to wait for.

Ambiguous failures never walk the pool because a partial stream may already have
performed tools or consumed allowance. Every terminal failure path reconciles
conversation truth before marking the turn failed, so a later user revival does
not replay work absent from history.

Rotating refresh tokens are protected separately: a workspace credential-scoped
Postgres advisory transaction lock serializes API/worker replicas before the
provider refresh call, waiters re-read the row after acquiring the lock, and the
existing `(id, version)` CAS remains the stale-family write fence. Refresh and
relogin-status writes also require health `status = 'active'`, so a refresh that
started earlier cannot reactivate or overwrite a definitive model quarantine;
this health fence does not read or change the independent `allocator_enabled`
new-allocation policy.

## Rollout and rollback

Migration `0053_codex_credential_leases.sql` introduced the additive lease
table, fairness columns, and temporary mixed-version cutover bits. Migration
`0403_codex_unconditional_credential_leasing.sql` is the maintenance activation
that retires those temporary bits. After 0403, the lease protocol is
unconditional and `rotation_enabled` is only the user-owned account-selection
policy described above.

Safe rollout order:

1. Build and pin one 0403-aware image digest. Confirm that API, control-worker,
   and turn-worker deployments all reference that same candidate.
2. Drain every pre-0403 API, control-worker, and turn-worker. Select
   `OPENGENI_DEPLOYMENT_MAINTENANCE_CUTOVER=0403_codex_unconditional_credential_leasing`
   and confirm the maintenance preflight only after the drain is complete.
3. Apply migration 0403, provision the runtime role, and start only the pinned
   0403-aware image. Never restart a pre-0403 binary against this schema.
4. Verify that both rotation tables no longer contain
   `lease_rotation_enabled`, every running Codex turn has an exact
   `(workspace_id, turn_id)` lease, rotation-on recovers the same turn on an
   eligible alternate, and rotation-off enters `waiting_capacity` when the
   active account is capped despite a healthy alternate.

Migration 0403 is forward-only. There is no environment or database switch back
to the legacy allocator. If an application defect appears after commit, keep the
0403 schema and deploy a corrected 0403-aware image. `rotation_enabled=false`
may temporarily constrain a workspace or organization pool to its active account,
but leasing and holder/generation fencing remain mandatory. A pre-0403 image is
not a valid rollback target because it still reads the removed cutover column.

Migration `0383_codex_cooldown_reconciliation.sql` is rolling. It adds typed
cooldown provenance and an independent revision. During mixed-version rollout,
its trigger preserves a legacy writer's `exhausted_until` change, advances the
revision, and clears only typed provenance so a new usage reader cannot
misclassify an unknown old-writer cooldown as quota.

## Secret-safe observability

Every leased selection emits workspace-RLS event `codex.credential.selected`
with the stable credential-row id, strategy/reason, pool counts, and reuse flag—no
tokens, provider bodies, email, or external ChatGPT identity. Activity spans carry
the stable credential id. Counters cover selections, definitive failure outcomes,
and eligible-pool depth. `CODEX_DEBUG` logs status/request id only, never the
provider response body.

The default PrometheusRule alerts when a workspace observes zero eligible
credentials (critical) or one eligible credential (warning). Operators should
correlate those alerts with `codex.credential.selected`,
`codex.account.switched`, and `turn.recovery.requested`/`turn.failed` events.

### Adaptive-fleet shadow and deterministic replay

The adaptive fleet shadow adds a second, deliberately more private decision-observability path. It
is independently default-off behind
`OPENGENI_CODEX_FLEET_POLICY_SHADOW_ENABLED=false` and runs **after** the allocator has
authoritatively selected or reused a lease. Shadow v1 cannot filter candidates,
change the selected credential, move a fenced turn, pace live work, alter a
capacity waiter, or trigger failover. Disabling the switch produces no shadow
payload or event and requires no schema rollback.

When enabled, `publishCodexFleetShadowDecisionV1` builds one bounded
`codex.fleet.decision` session event and appends it through the exact current
turn-attempt fence. Ordinary build/size/append faults return a bounded,
secret-safe failure classification and the turn continues on the allocator's existing
lease. `TurnAttemptFencedError` and Temporal cancellation are authoritative
lifecycle signals and are rethrown; swallowing either could let a superseded
activity continue mutating after the observer returned.

The durable replay record is designed for offline shadow simulation:

- At most 32 candidates and 34 KiB of UTF-8 JSON are retained. Candidate keys
  are event-local `c00`-style aliases assigned by HMAC-SHA-256 ordering with a
  fresh per-event seed; the seed and raw credential ids are never persisted.
  Unlike `codex.credential.selected`, these aliases are intentionally not stable
  account audit identities.
- Canonical policy, normalized input **including its truncation count**, and
  recorded decision each carry lowercase SHA-256 fingerprints. The strict
  reader rejects unknown envelope/decision fields, lossy normalization,
  malformed outcomes/scores, weak digests, and inconsistent admission or
  selection shapes before deterministic reevaluation.
- Quota windows are observations, not entitlement authority. Missing, partial,
  or stale windows lose confidence and cannot masquerade as pristine quota;
  only complete non-stale windows can enforce a new-placement ceiling.
  Workspace-local observed burn and confidence-labeled inferred unexplained
  burn are separate per-window percentage rates. For each complete, fresh quota
  window, runway pressure compares confidence-bounded exhaustion time with that
  window's own reset horizon and conservatively uses the highest bounded risk;
  an already-reset window is risk-free. Missing or stale reset/burn evidence is
  uncertainty, not fabricated usage. Unexplained/external burn is never
  relabeled as provider or tenant truth. Until typed producers exist, both
  per-window rates remain explicitly unknown in the worker snapshot.
- Cache affinity uses `unknown | healthy | collapsed` state with minimum token
  support, freshness, collapse/recovery dwell, and a higher recovery threshold.
  A single low sample cannot collapse affinity. The worker currently records
  cache input as unknown rather than deriving account truth from aggregate
  existing metrics.

The pure evaluator models later rollout phases without activating them. Default
policy keeps admission pacing, manager priority, the emergency fuse, and named
overlays independently disabled. Normal policy is adaptive and
work-conserving: pressure/runway, active leases, uncertainty, measured cache
affinity, and switch hysteresis rank **new** placements; it has no static hard
per-account slots and performs no preemption. Standard work borrows idle
capacity when no manager backlog exists. Manager priority may pace only new
standard work while queued manager demand consumes available capacity, with a
starvation bound. The emergency fuse also applies only to new work.

Named `prefer` overlays apply a bounded score benefit and always allow healthy
outside capacity to be borrowed. Explicit `isolate` is the only non-borrowing
mode: it is opt-in, reversible, reports the count of otherwise-eligible stranded
candidates, and never changes an in-flight fenced turn. These evaluator
semantics are not authorization or allocator lease/wait/failover state; a future
live integration must use the accepted-turn scope/filter seams and provider accounting's
read-only quota/freshness observations rather than mutating either owner's
state.

New Prometheus counters use fixed enum labels only: decision series are bounded
to 288 and error series to 6, with no workspace/account/tenant dimension. The
workspace-RLS durable event is exposed through the SDK's typed event mirror;
React projects only fixed enums, bounded numbers, and event-local aliases, drops
malformed/identity-shaped payloads, and labels the UI as shadow-only. Production
acceptance must preserve the measured prompt-cache baseline and compare
aggregate shadow outcomes before any independent live-policy switch is enabled;
the presence of shadow records alone is not evidence of adaptive benefit.

## Verification

- Pure unit/property coverage:
  `apps/worker/test/codex-rotation.test.ts`,
  `apps/worker/test/codex-usage-limit.test.ts`, and
  `packages/codex/test/fetch.test.ts`. Adaptive replay/policy and worker privacy,
  lifecycle, payload, and metric bounds are covered by
  `packages/contracts/test/codex-fleet-policy.test.ts` and
  `apps/worker/test/codex-fleet-shadow.test.ts`.
- Real Postgres concurrency/RLS/failure injection:
  `packages/db/test/codex-credential-leases.test.ts` and
  `packages/db/test/codex-capacity-waiters.test.ts`; fleet event ordering,
  multi-replica attempt fencing, replay, and FORCE RLS are covered by
  `packages/db/test/codex-fleet-shadow-events.test.ts`.
- Browser desktop/mobile overflow, keyboard, secret-safety, and WCAG-AA
  acceptance: `test/e2e/fleet-policy.browser.e2e.ts`.
 - Codex quota redemption-specific
  FORCE-RLS/OCC/idempotency coverage lives in
  `packages/db/test/codex-subscription-overview.test.ts` and
  `apps/api/test/codex-redemption-routes.test.ts`.
 - Authenticated desktop/mobile/a11y/browser-session recovery evidence:
  `test/e2e/codex-overview.e2e.ts`; the mutation-surface denylist is
  `test/codex-quota-redemption-surface.test.ts`.
- Real Temporal signal/timer/restart/continue-as-new coverage:
  `test/integration/temporal-workflow.integration.ts`.
- Production release proof must additionally show concurrent live turns selecting
  distinct eligible credential ids and one controlled exhausted credential
  recovering on another id without a duplicate turn/message.
