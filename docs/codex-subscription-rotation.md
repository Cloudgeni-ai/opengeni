# Codex subscription rotation

This is the canonical contract for selecting, leasing, refreshing, and failing
over ChatGPT/Codex subscription credentials. The implementation sources are
`apps/worker/src/activities/agent-turn.ts`,
`apps/worker/src/activities/codex-rotation.ts`, and the Codex accessors in
`packages/db/src/index.ts`.

## Security and scope

The **workspace is the complete scheduling boundary**.

- Credential rows, usage snapshots, cooldowns, fairness cursors, active pointers,
  session pins/last-used pointers, and leases are workspace-local and protected by
  FORCE RLS.
- OpenGeni does not create an account-global/provider-global subscription identity
  or correlate the same ChatGPT account across workspaces or managed accounts.
- If a user connects the same external subscription in two workspaces, both
  workspaces may use it concurrently. A lease/cooldown in one workspace never
  blocks or mutates the other.
- A selected credential id is revalidated against the transaction's RLS-visible
  candidate set. Composite `(workspace_id, credential_id)` lease FKs and triggers
  on legacy id-only pin/last/active references provide schema-level defense in
  depth against malformed internal writes.

This scope protects tenant isolation. Provider-side allowance is naturally
shared when the same external account is connected twice; each workspace learns
provider exhaustion independently and rotates among its own alternatives.

## Atomic selection and fairness

When `OPENGENI_CODEX_CREDENTIAL_LEASING_ENABLED=true`, every Codex turn calls
`acquireCodexCredentialLease` before model/tool preparation:

1. Start one RLS-scoped Postgres transaction and materialize/lock that
   workspace's `codex_rotation_settings` row with
   `FOR UPDATE`. Concurrent replicas wait; they do not `SKIP LOCKED`.
2. Lock the durable turn for share and verify it belongs to the exact
   account/workspace. If a downstream policy supplies an opaque accepted-turn
   scope resolver, resolve it from that locked turn metadata while the rotation
   transaction remains held.
3. Reap expired workspace leases and read all workspace credentials plus the
   count of unexpired leases held by other turns.
4. Offer a live same-turn lease or validated frozen run-state credential to the
   pure strategy against the complete workspace rows. Only if this is a new
   allocation may an optional downstream policy filter the candidate rows. Run
   the strategy and revalidate its chosen id against that resulting set.
5. Upsert the unique `(workspace_id, turn_id)` lease and increment the selected
   credential's server-held fairness cursor. The legacy active pointer advances
   in the same transaction only when the selector allows it; manual pins and
   sharded policy homes explicitly veto pointer movement.

`most_remaining` ranks eligible credentials by:

1. fewest active DB leases;
2. most remaining capacity across the binding five-hour/weekly windows;
3. fewest prior selections;
4. least-recent selection, then stable creation/id order.

The first and third/fourth inputs are server-held. Provider usage headers improve
capacity ranking but are **never the sole atomic allocator**. Consequently a
burst sees earlier reservations and spreads before delayed usage headers move.

The workspace active credential is a cursor, not a sticky lease. Pin source is
load-bearing: a `manual` (or defensively unlabeled) pin is user intent and never
silently fails over; if it is capped, the turn enters the same durable capacity
wait. A `policy` pin is a sharded cache-affinity home and may be re-sharded over
eligible candidates when that home caps. Policy pin writes use an observed-state
CAS inside the rotation-row-first capacity-mutation transaction, so a stale
sharding decision cannot overwrite a concurrent manual pin. Policy pins are
ignored and lazily cleared outside the active `sharded` strategy. A live/frozen
same-turn holder is reused before either pin policy or future membership
filtering, so cache policy never moves in-flight work. `rotation_enabled=false`
and `drain_then_next` remain explicit sticky product policies.

Named pool membership is intentionally not an OPE-21 concept. The generic
`CodexCredentialLeasePolicyScopeResolver<TPolicyScope>`,
`CodexCredentialLeaseCandidateFilter<TPolicyScope, TUnavailableDiagnostic>`,
and `CodexCredentialLeaseCandidateFilterResult<TUnavailableDiagnostic>` seams
let a downstream accepted-turn policy pass a private scope such as
`{primaryPoolId,fallbackPoolIds,policyHash}` into the existing rotation-row
transaction. The filter chooses candidates from exactly one resolved primary or
fallback scope and may return downstream-owned per-pool unavailable/reset
diagnostics; OPE-21 never union-ranks memberships and stores no pool table or
membership rule. `CodexCredentialLeaseResult<T, TUnavailableDiagnostic>` returns
those diagnostics. The new-allocation filter runs only after exact live/frozen
same-turn reuse, so a later membership/default change cannot move an already
accepted holder.

`codex_subscription_credentials.allocator_enabled` is a separate, additive
new-allocation gate (default `true`); it is not credential health. Setting it
false excludes the row from new automatic, pinned, proactive, and reactive
selection without changing `status`, encrypted credentials, refresh behavior,
or quota history. An exact same-turn live lease or frozen approval/preemption
checkpoint may continue on that healthy row; reconnect and token refresh never
flip allocator eligibility. OPE-24 owns toggle OCC/audit and product controls.

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

## Reset and failure semantics

Both the five-hour and weekly allowance windows bind. A cached capped window whose
provider reset timestamp has elapsed becomes eligible immediately; an all-capped
pool performs one bounded live usage refresh before idling. Unknown reset data
always yields a positive bounded delay, never a zero-delay loop.

If no healthy candidate exists for an active goal, `armCodexCapacityWait`
atomically marks the blocked turn failed once, releases its credential lease,
idles the session with reason `codex_capacity`, writes the audit events, and
creates or advances one `codex_capacity_waiters` row. The common lock order is
workspace rotation row → session → goal → blocked turn → live credential lease
(when reactive) → waiter. A reactive arm must still own the exact
holder/generation and worker-redispatch fence. The row records goal/control
generation, accepted `policyHash`, the earliest authoritative reset (when known),
bounded-refresh state, and `wakeRevision`/`observedWakeRevision`; it stores no
credential material or provider body.

`reconcileCodexCapacityWait` runs the normal metadata-only allocator decision
under the same rotation-row transaction. It accepts the same opaque
accepted-turn scope resolver/new-allocation filter as acquisition, so a named
pool policy can return per-pool diagnostics without union ranking or duplicating
the waiter. Unavailable decisions return `earliestResetAt`, `resetKind`
(`authoritative` or `bounded_refresh`), and optional secret-safe diagnostics;
unknown resets exponentially back off from one to fifteen minutes without
running a model. Availability commits one system
`goal.continuation` event and one queued turn, preserving model, reasoning,
resources, tools, and sandbox policy from the blocked turn. It does not create a
`user.message` or replay the failed turn row. The new turn resets execution-local
worker-death and credential-failover counters rather than inheriting budgets
consumed by the blocked turn. A second timer/signal observes the waiter as
resumed/stale and enqueues nothing.

`withCodexCapacityMutation` is the same-transaction mutation/outbox seam for any
eligibility or future pool membership/default write: it locks the workspace
rotation row first, applies the mutation, increments matching waiter wake
revisions only when truth changed, and returns secret-safe signal targets.
`listPendingCodexCapacityWakeTargets` repairs commit→signal loss. The session
workflow's `codexCapacityChanged` signal is only a nudge; the Postgres revision
is authoritative. The workflow snapshots its wake counters before dispatching a
turn, so a signal delivered after waiter commit but before the activity result
returns causes immediate reconciliation instead of being baselined away. It
reconstructs pending timers on worker/Temporal restart and `continueAsNew`.
`reconcileCodexCapacityWait` atomically rechecks human queue, effective Pause,
goal, policy, blocked-turn identity, and duplicate-work fences before recording
the typed capacity-resume update; ordinary attempt claim repeats admission before
provider/model/tool/billing work starts. Reset/boost entitlement redemption is
never automatic.

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
bounded by pool size so a malformed classification cannot walk forever; a stale
holder cannot quarantine a credential or settle the turn.

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

Migration `0053_codex_credential_leases.sql` is additive. It creates the
workspace-local lease table and fairness columns, strengthens workspace reference
integrity, and adds a separate `lease_rotation_enabled` cutover bit. Both that bit
and the legacy `rotation_enabled` column keep a database default of `false`, so a
schema-first migration or an older binary can never opt a workspace into mixed-mode
rotation. First-connect code also leaves the new bit false. An explicit settings
write updates both generations only after the compatible fleet is ready.

The deployment flag, legacy user-intent bit, and workspace cutover bit are all
required for leasing. With the deployment flag off, or unless both
`rotation_enabled=true` and `lease_rotation_enabled=true`, a new worker preserves
the old binary's exact pin/legacy-rotation policy and leaves the lease table plus
fairness cursors inert. The supported settings write keeps both database bits in
sync; a torn/manual legacy write fails closed. This makes the database row the
atomic fleet-wide cutover—process-local environment changes alone never split a
workspace between allocators.

Safe rollout order:

1. Apply the migration and deploy the compatible revision with
   `OPENGENI_CODEX_CREDENTIAL_LEASING_ENABLED=false`.
2. Wait until every API/worker replica is on that revision. Mixed old/new workers
   still use the same legacy pin/rotation policy and never touch the lease table.
3. Enable the deployment flag and wait for that same immutable revision/config to
   finish rolling out. Workspace cutover bits remain false, so this restart is
   still legacy-only.
4. Through the normal workspace-admin settings path, explicitly enable rotation
   for the controlled staging workspace. This sets `rotation_enabled` and
   `lease_rotation_enabled` together; all compatible replicas switch atomically on
   the database row. Prove concurrent distribution and exhaustion recovery, then
   repeat the same controlled workspace cutover in production.

Immediate workspace rollback is clearing `lease_rotation_enabled` (the normal
rotation-off settings write clears both generations). Do that before rolling the
deployment flag back to `false`; every replica immediately returns to the legacy
path without a schema rollback. The additive table/columns remain inert. An older
binary is also compatible with the additive schema.

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

OPE-32 adds a second, deliberately more private decision-observability path. It
is independently default-off behind
`OPENGENI_CODEX_FLEET_POLICY_SHADOW_ENABLED=false` and runs **after** OPE-21 has
authoritatively selected or reused a lease. Shadow v1 cannot filter candidates,
change the selected credential, move a fenced turn, pace live work, alter a
capacity waiter, or trigger failover. Disabling the switch produces no shadow
payload or event and requires no schema rollback.

When enabled, `publishCodexFleetShadowDecisionV1` builds one bounded
`codex.fleet.decision` session event and appends it through the exact current
turn-attempt fence. Ordinary build/size/append faults return a bounded,
secret-safe failure classification and the turn continues on OPE-21's existing
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
  OPE-31 metrics.

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
semantics are not authorization or OPE-21 lease/wait/failover state; a future
live integration must use OPE-21's accepted-turn scope/filter seams and OPE-24's
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
  `packages/codex/test/fetch.test.ts`. OPE-32 replay/policy and worker privacy,
  lifecycle, payload, and metric bounds are covered by
  `packages/contracts/test/codex-fleet-policy.test.ts` and
  `apps/worker/test/codex-fleet-shadow.test.ts`.
- Real Postgres concurrency/RLS/failure injection:
  `packages/db/test/codex-credential-leases.test.ts` and
  `packages/db/test/codex-capacity-waiters.test.ts`; OPE-32 event ordering,
  multi-replica attempt fencing, replay, and FORCE RLS are covered by
  `packages/db/test/codex-fleet-shadow-events.test.ts`.
- Browser desktop/mobile overflow, keyboard, secret-safety, and WCAG-AA
  acceptance: `test/e2e/fleet-policy.browser.e2e.ts`.
- Real Temporal signal/timer/restart/continue-as-new coverage:
  `test/integration/temporal-workflow.integration.ts`.
- Production release proof must additionally show concurrent live turns selecting
  distinct eligible credential ids and one controlled exhausted credential
  recovering on another id without a duplicate turn/message.
