<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may have moved. Code wins.

# Subscription core: data model, architecture and migration (2026-10-07)

This record designs the shared subscription core that implements
[subscription-accounts.md](../subscription-accounts.md) for Codex, Claude and
SuperGrok. Current behaviour is documented in
[subscription-accounts-inventory.md](../subscription-accounts-inventory.md);
EP-, CA- and Part references point there. Revision 2 incorporates an
independent design review (summarised in [section 9](#9-review-changes)).

## 1. Decisions

1. **One provider-keyed table set.** Connections, scopes, settings, session
   bindings, leases, waiters, turn failures and quota live in one set of
   `subscription_*` tables keyed by `provider`. Adding a provider adds a value
   and an adapter, never tables, SQL functions or policies. The bespoke Codex
   tables and the per-provider factory tables are retired. The Claude tables
   are a one-time text clone of the xAI tables that already drifts (Part 4
   §4.4.1), and Codex differs in every concern, so a single set is the only
   shape where "every capability for every provider" is structural.
2. **Move once per provider; no dual write.** Before cutover the core runs in
   shadow on top of the legacy tables through a read-only adapter. Each
   provider then cuts over in one drained maintenance migration that moves its
   rows (secret included) into the new tables inside the owner-only RLS
   window. Legacy tables become read-only for forensics and are dropped
   later. This is the existing practice for one-way cutovers (0403, 0492,
   0598) and avoids two copies of a rotating refresh token.
3. **Existing ids are preserved**, so events, audit rows, video envelopes and
   recent history keep pointing at the same account.
4. **A pure policy package decides; SQL enforces authority.** Placement is a
   pure function in a new `@opengeni/subscriptions` package. Authorization
   (scope, people, personal ownership, private-session access) is enforced in
   SQL, so a policy bug can at worst pick a worse account, never a forbidden
   one. Effective settings are resolved by SQL for enforcement, and a parity
   test pins the TypeScript copy to it.
5. **The account belongs to the session.** One chat binding per session.
   Explicit choice lives only on the binding, never in frozen turn authority.
6. **Accepted work freezes only personal authority**, per provider. Shared
   eligibility is checked live.
7. **Spread is a deterministic hash** of the session id over eligible accounts
   (D-21). No cross-session lock is needed (SUB-SEL-05).
8. **Cross-provider failover requires portable compaction.** New sessions use
   portable compaction whenever a cross-provider fallback is in effect for
   their model; existing Codex remote-compaction sessions convert at their
   next compaction while Codex still has capacity, and until then fail over
   only within Codex (D-19, see §6.4).

## 2. Architecture

```
consumers: chat turns, schedules, children, compaction, transcription, realtime, media, tool gateway, billing
        |
@opengeni/subscriptions (pure)   contract types, effective settings, placement, failover order,
        |                         cache coldness, adapter interface, shared quota model
packages/db subscriptions repo    connect/disconnect, scopes, settings, placement + lease (one
        |                         transaction), binding, waiters, turn failures, quota; SQL authority
provider adapters                 codex (packages/codex), xai (packages/xai-subscription),
                                  claude (packages/runtime anthropic path), API-key connectors
```

### 2.1 Adapter interface (SUB-PROV-01, SUB-PROV-02, SUB-PROV-04)

| Member | Purpose |
| --- | --- |
| `provider`, `capabilities` | Stable id and flags: `autoRenews`, `resetCredits`, `modelEntitlements`, `realtime`, `fundsMedia`, `apps`, `remoteCompaction`, `quotaWindows`. |
| `signIn` | OAuth, device code or setup token; returns an encrypted secret plus identity (provider account id, email, plan). |
| `refresh` | Token refresh under the core's single per-connection lock; returns the new secret. The core increments `refresh_generation` on every refresh. |
| `transport` | Request-local authorization and wire normalization for one selected connection. |
| `decodeQuota` | Provider usage responses or headers to the shared quota model. |
| `entitledModels` | Models the connection's plan can serve, including provider-observed exclusions (Codex plan entitlement). |
| `classifyError` | Shared outcomes: `exhausted(resetAt?)`, `rate_limited(retryAfter?)`, `unauthorized`, `forbidden`, `entitlement_missing(model)`, `overloaded`, `transient`, `fatal`. |
| `cacheFacts` | Exact TTL (Claude) or measured idle cut-off (Codex, SuperGrok). |
| `historyCompatibility` | Which provider-specific history items (encrypted reasoning, thinking signatures, provider tools) must be dropped from a request copy when another provider serves the session. |

API-key connectors implement `provider`, `capabilities`, `transport`,
`classifyError`, `cacheFacts`, `entitledModels` and `historyCompatibility`
with a static credential and no quota windows. They are stored as
connections with `kind = api_key` in the same table, which makes them
failover targets and gives non-agent consumers one way to obtain a model
credential. Moving the existing API-key connection tables is a separate,
later step.

### 2.2 Shared quota model

```
{ windows: [{ id, usedPercent | null, resetsAt | null, status: ok | warning | exhausted | unknown }],
  modelCooldowns: { [modelId]: resetsAt },
  exhaustedUntil, exhaustedKind: quota | rate_limit | null, revision,
  observedAt, observedRefreshGeneration, source: usage_endpoint | response_headers | refusal }
```

An observation is applied only if `observedRefreshGeneration` equals the
connection's current `refresh_generation`, so a stale refusal cannot
quarantine a renewed credential (this replaces `version` fencing, which does
not change on Claude refresh).

## 3. Data model

Every table is `ENABLE` + `FORCE ROW LEVEL SECURITY` and keyed by
`account_id` (the organization).

### 3.1 `subscription_connections`

- Identity: `id` (preserved), `account_id`, `provider`, `kind`
  (`subscription` | `api_key`), `provider_account_id`, `account_email`,
  `label`, `plan_type`.
- Uniqueness: one row per (organization, provider, provider account, owner),
  where owner is the personal owner or "shared". Migration deduplicates rows
  that today differ only by workspace, keeping the healthiest row's id and
  recording the others as aliases (`subscription_connection_aliases`) so old
  references still resolve (one upstream quota must not look like N
  accounts).
- Secret: `credential_encrypted`, `credential_format`, `expires_at`,
  `last_refresh_at`, `refresh_generation`, `version` (metadata OCC). One lock
  per connection id serializes every refresh, in every consumer.
- Health and allocation: `status`, `last_error`, `allocator_enabled`,
  `allocator_version`, `excluded_models` (entitlement exclusions observed by
  the adapter; read by eligibility, SUB-ELIG-03), `allowed_model_ids`
  (administrator access policy).
- Ownership: `ownership` (`shared` | `personal`). Personal rows carry the
  generic `organization_user_resource_authorities` tuple
  (`owner_organization_membership_id`, authority id, generation) with the new
  resource kind `subscription_connection`, and are not bound to a workspace.
- Scope (shared rows): `scope_kind` (`organization` | `workspaces` |
  `people`) and `allow_personal_workspaces`; assignments in
  `subscription_connection_workspaces` and `subscription_connection_people`
  (people are organization memberships). Organization scope means every
  current and future workspace.
- Management: `managed_by_workspace_id` (delegated management). Delegated
  managers can reconnect, rename, toggle allocation and, from the managing
  workspace, choose the connection's models (migration 0702); only
  organization administrators change scope, ownership, or delete (SUB-OWN-04).
  `connected_by_subject_id` is audit only.
- `provider_state` jsonb is adapter-owned (for example Codex reset-credit
  counts); core decisions never read it.

### 3.2 `subscription_connection_quota`

One row per connection with the shared quota model and placement statistics
(`selection_count`, `last_selected_at`).

### 3.3 Settings

- `subscription_settings`: one organization row (`workspace_id` NULL, every
  value set, `locked_settings`), optional workspace rows (NULL = inherit).
  Values:
  - `rotation` per provider: `primary_first` with `primary_connection_id`
    (foreign key, `ON DELETE SET NULL`; a missing primary means spread), or
    `spread`.
  - `providers` per provider: `use_organization_accounts` (bool) and
    `enabled` (bool), plus `inference_source` (`automatic` | `workspace` |
    `organization`). `inference_source` is the authoritative pool-source
    selector; `enabled = false` projects the legacy `disabled` mode. The older
    `use_organization_accounts` field remains a compatibility projection
    (`false` only for `workspace`) and is not sufficient by itself to express
    organization-only selection. These settings never mutate connection scope
    or the model allowlist (§5.2).
  - `cross_provider_failover`, `fallback_order` (per model).
  - `personal_connections_allowed`, `personal_fallback_allowed`.
  - `version`, `updated_by_subject_id`, `updated_at`.
- `subscription_person_preferences`: per organization membership,
  `personal_fallback_opt_in`.
- `subscription_effective_settings(account_id, workspace_id)` (SQL) is the
  enforcement source; the TypeScript `effectiveSettings` has a parity test.
  An organization overview reads the same function for every workspace
  (SUB-SET-05).

### 3.4 `subscription_session_bindings`

Primary key `(workspace_id, session_id)`: `provider`, `connection_id`,
`model_id`, `choice` (`automatic` | `explicit`), `only_this_model`,
`last_model_call_at`, `last_switch_reason`, `version`.

- `last_model_call_at` is written when each model call completes (finalization
  and mid-turn placement), not only at turn start, so a long turn is not
  mistaken for a cold cache.
- Child sessions and scheduled runs that create a new session start
  `automatic` (their prompt cache key is their own session id, so there is no
  warm cache to keep). Forks copy the binding as `automatic`.
- The binding is the chat binding only. Media funding and realtime place their
  own accounts per operation and never write it (fixes EP-N12).

### 3.5 `subscription_leases`

Primary key `(workspace_id, turn_id)`: `connection_id`, `provider`,
`holder_id`, `generation`, `leased_until`. Fencing as today
(SUB-LEASE-01..03). Revocation found at renewal does not abort the in-flight
request; it marks the lease for failover at the next model-call boundary.

### 3.6 `subscription_capacity_waiters` and `subscription_turn_failures`

- Waiters: one per session, provider neutral, with the union of today's
  fields including `policy_hash`, `reset_kind`, `refresh_attempt` and
  `resumed_update_id`, plus `wait_reason`. Compaction turns wait like any
  other turn.
- Turn failures: per (turn, connection) failure receipts with recovery
  evidence, generalising `unresolvedCodexCredentialFailures`, and a per-turn
  failover bound so a turn cannot bounce between accounts forever.

### 3.7 Accepted authority v2

`subscription_authority` jsonb, immutable once written, on `session_turns`,
`scheduled_tasks`, `scheduled_task_revision_authorities`,
`session_system_updates`, the outbox and `sessions.initial_*`:

```
{ version: 2, personal: [{ provider, ownerMembershipId, authorityGeneration }] }
```

- Only personal authority is frozen, per provider, because it is a human's
  authority. A v1 `user` snapshot for one provider maps to exactly that
  provider; the owner membership is derived from the exact initiating human,
  and its `authorityGeneration` is preserved from validated resource-authority
  evidence (not replaced with the membership's current `authorization_revision`).
  Shared eligibility is never frozen.
- Agent messages and Steer take the receiving session's value; non-human
  acceptance (API keys, operators, Slack, service schedules) freezes no
  personal authority (SUB-ACCESS-01).
- The inbox execution-context fence (0608) and scheduled admission (0275,
  0478) compare Codex against its v2 entry while continuing to compare Claude
  and xAI against their existing provider-specific v1 columns through M4/M6.
  M3 must not replace those deferred-provider comparisons with v2, which does
  not encode their legacy shared-pool scope or generation.
- Provider cutovers are additive and provider-scoped. M3 writes only the
  Codex entry in v2 on live accepted-work rows, including scheduled tasks,
  while preserving all existing v1 columns byte-for-byte. Claude and xAI
  continue using their current v1 readers until their own M4/M6 cutovers;
  neither M3 nor its matched release may remove or bypass those readers. A
  later provider cutover uses that provider's v1 snapshot as a compatibility
  authority for already-accepted work when its v2 entry is absent, preserving
  the exact legacy shared-pool scope as well as personal scope. It must not
  rewrite an already-written v2 snapshot or reconstruct old authority from
  current settings. Keep the provider's v1 reader until every live accepted
  turn, scheduled execution and causal continuation that depends on it is
  terminal or has an equivalent immutable, verified authority record; moving
  new callers alone is not sufficient.

### 3.8 Authorization and row-level security

- Shared connection rows are visible to administrators and to workspaces in
  scope; people scope is evaluated against the **session owner**, the person
  whose session spends the account.
- Personal rows are usable only for work whose session owner is the owner and
  whose accepted authority lists that provider and owner, in the owner's
  private sessions or Personal workspace. The check is a `SECURITY DEFINER`
  function that takes the session owner and the turn's human as explicit
  arguments and reads memberships through the existing per-transaction
  capability pattern (0234), never through an empty subject. The v2 personal
  placement helper also requires that provider's cutover row to be enabled,
  the exact `session_access` capability to exist, effective personal access to
  be enabled, and the frozen resource-authority generation to match an active,
  non-revoked resource. It leaves only per-connection, owner/provider-scoped
  capabilities in the transaction. Before drained cutover, this helper is
  inert and v1 remains authoritative.
- Ownerless sessions are shared-only: they may use organization- or
  workspace-scoped shared connections only. The database rejects personal and
  people-scoped connections for ownerless turns. Bindings remain denied because
  they do not carry an exact accepted-turn identity.
- Binding, lease, waiter and failure rows reference the session and inherit
  `session_visibility_isolation`. Core operations run with the acting turn's
  initiating human (`withSubscriptionPoolSessionAccess`, SUB-ACCESS-02..04).
  A non-human turn in an owned session runs as `service:subscription-core`
  with the verified session owner only for that exact session; it has no
  personal authority unless the immutable accepted authority and live resource
  fence both allow it. A genuinely ownerless session has no substitute human:
  M3 adds a narrowly scoped ownerless-session capability keyed to the exact
  account, workspace, session and turn, requiring `session.owner_subject_id`
  and `turn.initiating_human_subject_id` to remain NULL and the service actor
  to be `service:subscription-core`. It permits shared organization/workspace
  connections only. It cannot read or bind a personal connection, use
  person-scoped assignments, or acquire personal fallback; it is rechecked on
  placement, renewal, dispatch and waiter recovery. The existing non-null-owner
  capability remains unchanged for owned sessions.
- Membership removal (0263) learns the `subscription_connection` resource
  kind and revokes personal connections on leave (SUB-ACCESS-06).

## 4. Placement

One transaction per placement, following the canonical lock order:
workspace control, then session, turn and attempt, then the session binding
row (created with `INSERT … ON CONFLICT DO NOTHING` before it is locked).
No provider call happens inside it.

1. Read effective settings (SQL).
2. If the binding is `explicit`, use that connection or wait
   (`pinned_account_unavailable`); a choice that can never serve the work
   waits as `pinned_account_ineligible` (D-24).
3. Candidate models: the preferred model, then the fallback order (same or
   other providers, the latter only if cross-provider failover is on), or
   only the preferred model when the session is "only this model"
   (SUB-FAIL-05); filtered by workspace restrictions,
   connection `allowed_model_ids`, entitlements and per-model cooldowns. A
   preferred model the workspace does not allow falls through to the allowed
   candidates, and the session waits only if none is allowed (D-17). A
   provider switched off for the workspace and a compaction provider lock
   restrict models the same way (D-26).
4. Keep the bound connection if it can still serve its model, the cache is
   warm, and no re-selection point applies (compaction completed, model
   changed, session became shared while on a personal account).
5. Otherwise, per candidate model: shared connections that can serve it,
   ordered by rotation (the primary first, regardless of whether its quota
   is known), then by a deterministic
   hash of the session and connection ids (D-21, D-23); then, with personal
   fallback, the owner's personal connections for the same model; then the
   next model.
6. Nothing servable: arm the session waiter with the earliest known reset
   (D-22), explaining a compaction lock when it is what keeps a usable model
   away.

Mid-turn failover happens only between model calls: the turn records a new
execution-policy revision, re-runs the funding check (`ensureRunAllowed`)
for the new provider, drops provider-specific history items from the request
copy (`historyCompatibility`), and keeps completed tools and accounting.
Image and video operations key their idempotency on the turn and call, not
the credential, so a failover cannot spend twice (SUB-ACCT-02).

The reference model (`packages/subscriptions/src/reference-model.ts`)
implements this algorithm independently; conformance compares production
decisions with `checkDecision`.

## 5. Migration

### 5.1 Steps

| Step | Change | Mode | Behaviour |
| --- | --- | --- | --- |
| M1 | `@opengeni/subscriptions` package, reference-model conformance, and a read-only legacy adapter that builds the placement world from today's tables. Shadow placement at turn start records a content-free comparison: eligible-account sets (security parity), `checkDecision` on the core's decision, would-switch rate, and the inputs the Codex fleet shadow omits. | rolling | none |
| M2 | New tables, functions and policies, empty. Generic membership-lifecycle kind. Per-organization, per-provider cutover switch stored in the database. | rolling | none |
| M3 | Codex cutover: drained maintenance migration moves Codex rows (dedupe, aliases, secrets, bindings, leases, live waiters with generation and wake revision, v2 authority backfill) inside the owner window with explicit account-context parity counts; every Codex consumer (chat, compaction, transcription, realtime, image, Apps, reset credits, usage routes) switches in the same release. Workflow activities keep their names and accept both waiter shapes. | maintenance | Codex on the core |
| M4 | SuperGrok, then Claude, the same way; synthetic pool subjects and per-provider SQL functions retired. | maintenance | per provider |
| M5 | Product features: scopes and people, personal connections for every provider, settings with overrides and the overview, cache-aware stickiness, cross-provider failover and portable-compaction defaults. API and UI, previewed before merge. | rolling | product |
| M6 | Drop legacy tables, columns, triggers and functions. | maintenance | none |

Each migration declares its `deployment-mode`, opens the owner-only
`NO FORCE` window around backfills (`check:migration-rls-backfills`),
budgets ledger-replaying tests at 180 000 ms, and registers at all three
release-schema contract sites.

One-way points: after a provider's cutover migration commits, older images
must not restart, and rollback is forward-only (a fix-forward release),
as for 0403, 0492 and 0598. Everything before M3 is reversible.

### 5.1.1 M3 implementation plan

This addendum is the implementation boundary for M3. It cuts over Codex only;
Claude and SuperGrok continue through their existing paths and retain the M1
shadow comparison. No web UI redesign or new visible control is in scope. The
existing Codex account/session surfaces must continue to work through the
compatibility projections and event aliases below.

#### Rolling precursor and drained cutover sequence

M3 begins with a rolling-compatible precursor that adds only nullable v2
accepted-authority storage and an inactive Codex credential-refresh seam whose
authorization is exact-turn and live-lease fenced before the provider call. It
performs no backfill, secret copy, data move, or
cutover-gate activation. Every provider continues to read its existing v1
accepted authority, and old API/worker binaries remain compatible. The
selector/materializer can be deployed only after this precursor is present;
the final one-way migration still requires the complete runtime drain described
below, then backfills v2 authority and activates the Codex cutover together.

The precursor also repairs the gated ownerless-session authorization seam: an
ownerless session is shared-only, must be workspace-visible, and may lease only
shared organization- or workspace-scoped connections. Private sessions,
human-initiated turns, personal connections, people-scoped connections, and
ownerless session bindings remain rejected. This is a database authorization
fix, not a v2 authority writer or an early selector activation.

The nullable v2 accepted-authority slot is immutable to application sessions
after acceptance, matching the existing v1 snapshot contract. Only the
`session_turns` table owner can populate it during the later drained backfill;
ordinary app-role writes, including writes nested under `SECURITY DEFINER`,
cannot rewrite accepted authority. The precursor itself does not write v2
snapshots.

Accepted v2 snapshots store canonical lowercase membership UUIDs only. The
`session_turns` CHECK and the TypeScript schema both reject other spellings,
and the placement reader compares as `uuid`, so a stored snapshot can never
look valid while silently failing to match.

The v2 personal-placement helper never rewrites or removes a capability the
caller already held in the same transaction (for example an earlier v1 Claude
authorization for the same owner). It inserts with `ON CONFLICT DO NOTHING`
and limits every cleanup to the rows it inserted itself.

##### Codex credential refresh seam

Codex OAuth refresh tokens rotate: once the provider accepts the old refresh
token, only the returned token is valid. Refresh is therefore split into two
calls inside one transaction around the provider request.

1. `begin_subscription_codex_refresh` authorizes before the network call. It
   takes the per-connection advisory key `subscription-refresh:<connection
   id>`, then checks the exact accepted session and turn, session access
   (owned, service or ownerless), the live lease holder and generation,
   shared-only scope for ownerless turns, the frozen personal authority for
   personal connections (through the same helper the lease guard uses, whose
   authority source the drained cutover switches to v2), whether personal
   connections are allowed now, and current visibility. It requires an active
   `subscription`-kind Codex connection, returns the credential to rotate, and
   mints a one-shot `codex_refresh_authorized` capability that no RLS policy
   reads. A second `begin` for the same connection in one transaction is
   refused, and a personal capability the caller already holds for another
   turn is left untouched and refuses the refresh.
2. `persist_subscription_codex_refresh` runs as soon as the provider returns.
   It consumes that capability and writes under the still-held advisory lock and
   the `refresh_generation` compare-and-swap only. A short-lived
   `codex_refresh_write` capability exposes the exact row to that one UPDATE
   (SELECT and UPDATE policies) and is removed before the function returns.
   It runs with no lock timeout so a briefly held row delays rather than aborts
   the write, and it does not bump the metadata `version`.

`refresh_generation` is enforced for every writer by a trigger: it never
moves backwards, it advances by at most one per write (so its safe-integer
CHECK ceiling is unreachable), and any change to the stored credential
advances it. An administrator replacing a credential during an in-flight
refresh therefore makes that refresh's compare-and-swap fail instead of being
overwritten. No writer may advance the generation without changing the
credential: that would only make an in-flight refresh discard its rotated
token.

Decision (strictest design that does not strand a shared credential):
persistence deliberately does not repeat lease-expiry, visibility, settings or
authority checks. Refusing the write after rotation would leave the connection
needing a fresh login for every user, while writing it back gives the turn
nothing it does not already hold. Authorization for the turn's own use of the
credential is still decided before the call; the rotated token is only stored.
A connection disabled during the call keeps a usable token; a deleted row
matches nothing. The caller must persist before any other fallible work,
because a rolled-back transaction also discards the rotated token.

Lock order: the advisory key first, then the connection row (taken
`FOR NO KEY UPDATE` by the UPDATE, which does not block foreign-key checks).
Neither function locks the lease row, and no row lock is held across the
provider call, so lease renewal, release, takeover and connection
administration never wait on a refresh. Any future writer that replaces a
Codex credential, such as reconnect, should also take the same advisory key so
it does not race the provider call itself.

Residual risk, accepted for now: a rotated token is still lost if the
surrounding transaction fails after `persist` (commit failure, a dropped
connection, or an idle-in-transaction timeout during a slow provider call).
Moving refresh to a session-level advisory lock with its own short persist
transaction would remove it; that belongs with the refresh consumer.

#### Runtime and consumer entry points

Every Codex entry point in the inventory is assigned to the shared core. The
provider adapter owns only Codex wire requests, OAuth/token normalization,
usage/quota parsing, plan/entitlement observation, and typed refusal
classification; it does not choose accounts, write pins, lease credentials, or
refresh tokens outside the core's per-connection lock.

| Inventory entry points | M3 path |
| --- | --- |
| EP-T01–T05: turn claim/model policy, chat placement, credential materialization, leases and dispatch fencing | Keep the worker/activity boundary and call the provider-neutral placement/materialization API with provider `codex`, accepted personal-authority v2, current session owner, workspace policy, and the current attempt fence. One lease and generation-fenced connection refresh lock apply to Codex exactly as to other providers. Remove the Codex-only `codex-rotation.ts` selection call. |
| EP-T06–T08: failure settlement, finalization, usage and lease release | Convert Codex refusals to core failure receipts; let core eligibility/quarantine/failover/wait rules decide. Record usage/quota against the leased `connection_id`, release through the common lease API, and retain idempotent settlement fences. |
| EP-T09–T10: capacity wait/recovery and wakes | Store waiters in `subscription_capacity_waiters` with turn/attempt, lease generation, `wake_revision`, and reset metadata. Reconcile and signal via provider-neutral repository/outbox APIs. Preserve existing Codex outbox delivery guarantees and keep retry/peek bounded. |
| EP-T11–T15, EP-T18: accepted authority, goals, child agents, inbox updates, schedules, model listing | Codex core reads only its immutable v2 authority entry; the migration preserves Claude/xAI v1 snapshots and their current readers until M4/M6. Only personal authority is captured, shared eligibility stays live. Codex model readiness/listing calls the same core eligibility projection with explicit account context; it must not reintroduce a Codex live selector. |
| EP-T16 and EP-S18–S25: compaction, admission and availability | `portable` compaction uses ordinary candidate-provider eligibility and may fail over as core policy permits. Existing `remote_v2` sessions keep remote Codex compaction and their current model lock until a successful Codex compaction converts the session to portable; the lock is represented as a candidate-model/provider restriction, not a separate Codex placement branch. Compaction uses the same lease, accepted authority, wait/recovery and history-sanitization boundaries as a chat turn. New-session default behavior is unchanged in M3. |
| EP-T17, EP-N08–N10: image generation and operation ledger | Place each Codex image operation through the core under the turn's accepted authority, with a per-operation lease and turn/call idempotency key. Resume/reconcile the existing operation ledger without reissuing an uncertain upstream write. Media placement never mutates the chat binding. |
| EP-N01–N04: transcription service, Codex transcription and HTTP/resumable recording routes | Keep provider ordering and recording segment ledger semantics. Provider ordering selects the initial provider only; once a subscription provider operation is selected/attempted, a refusal or transport failure does not retry the same audio through another provider in M3, per D-09 and §6.5. The Codex adapter receives explicit request owner/workspace context and obtains an operation lease through core eligibility; remove active-pointer-only token loading. Subscription transcription remains non-chargeable. |
| EP-N05–N07 and EP-S17: realtime catalog/begin, Codex WebRTC broker, and realtime selection | Catalog readiness uses core eligibility. Each session realtime operation resolves the session's accepted owner context, places and leases a Codex connection via core, and serializes refresh on that connection. Keep current client protocol and HTTP error translation; realtime operations do not write the chat binding. |
| EP-N11–N14: video funding, credential selection, admission envelope and crash reconciliation | These paths currently have no Codex-specific video adapter; keep video owned by its existing provider adapter and preserve its operation ledger. Remove any Codex active-pointer or copied-token assumptions if shared funding or recovery touches Codex, and route any Codex-funded operation through the core lease and serialized refresh rather than adding a new Codex selector. |
| EP-N15–N17: Codex Apps gateway, turn-time Apps auth, designation and clear/off | Keep designation separate from chat placement, but resolve its connection/alias and load its secret through core authorization and serialized refresh; remove any effective-pool-only token gate. Preserve setup-card and turn behavior. Clearing Apps must remain valid regardless of source mode. |
| EP-N18: reset-credit prepare/redeem | Resolve the supplied legacy account id through aliases to a core connection and use the core secret/refresh lock and redemption ledger. Keep routes, payloads, HMAC confirmation and single-use fences, but use the §6.3 authority: same-origin managed browser human who is an organization administrator or that connection's delegated manager. The prior connecting-human/acting-person-agent rule is superseded; do not permit bearer, MCP/service, scheduled or agent-acting-as-person redemption. Do not route redemption through automatic placement. |
| EP-N19–N20: funding bypass and usage attribution | Replace the Codex live-account predicate with a core eligibility/funding result using explicit workspace, session owner, accepted authority, and model. Keep subscription-use billing bypass (no deployment-credit charge) but do not let a stale/static catalog flag bypass admission. Attribute accepted usage to the selected connection. |
| EP-N21–N27: usage/overview/refresh routes, quota refresh, readiness and scheduled/parent authority | Preserve route behavior through adapters over core projections and refresh APIs. Every batch refresh supplies explicit organization/workspace/provider/connection context and uses the per-connection refresh lock; usage reads may trigger existing bounded wake reconciliation but never select through legacy active pointers. Parent/schedule readiness uses causal owner and frozen personal authority, never viewer inference. |
| EP-N28 and M1 shadow | Keep shadow comparison enabled for Claude and SuperGrok legacy paths. Codex's old-vs-new selector shadow is removed when the old selector is deleted; retain provider-neutral core observability, content-free and attempt-fenced. |
| EP-S01–S07, EP-S09–S16, EP-S26: Codex workspace/organization connect, list/status/source, account mutations, usage, Apps, access policy, SDK | Keep current route paths, methods, payloads and response compatibility. Handlers become adapters over organization-owned core connections/settings and convert legacy account ids through aliases. Preserve source names (`automatic`, `workspace`, `organization`, `disabled`) as projections over effective provider settings. Retain current authorization except where the contract explicitly supersedes it: Apps designation and reset redemption use §6.3 authorities, and redemption is browser-only. Add typed SDK methods for existing raw organization Codex routes only as needed to preserve API parity; do not remove existing method names or response fields. |
| EP-S08, EP-S27, EP-S29, EP-S31: session projection/pin, React hook, account indicator, event/status compatibility | Back the existing Codex projection and pin endpoint with the session binding. Preserve selected/waiting projections and `codex.account.*`, `codex.capacity.*`, and `codex.credential.selected` events as aliases emitted from canonical subscription events; map old payloads and reason/status enums deterministically. No visible redesign is included. |
| EP-S28, EP-S30 and remaining Codex-only bypasses | Keep current web account, model, audience and `remote_v2` controls unchanged; API/SDK compatibility aliases feed them. Remove every Codex-specific route into selection/routing, including `codex-rotation.ts` and Codex-only capacity/recovery branches. Do not change UI; if compatibility requires visible behavior, stop before merging it and obtain product-owner review with a real-component preview. |

#### Operation leases, policy dedupe and bindings

The M2 `subscription_leases` row is turn-scoped and cannot stand in for an
operation lease: transcription may have no session/turn, realtime has a
session but no turn, and multiple image operations can overlap one chat turn.
Add a provider-neutral `subscription_operation_leases` table/API in the core
runtime PR, keyed by operation id (and attempt/generation), separate from the
chat-turn lease. Carry organization, workspace, operation kind, connection,
holder, generation and expiry, with optional session/turn references for
session-bound work. Renew, pre-dispatch assert, release and expiry recovery
must all fence on exact operation id and generation; a media lease never
replaces or renews the chat lease. Every operation uses the common
per-connection refresh lock. RLS and database guards authorize a bound
session/turn through the same session-owner and initiating-human capability
seams as chat. Sessionless transcription requires explicit workspace-grant
and initiating-human context and can use only shared connections whose scope
includes that workspace; personal connections require an eligible private or
Personal-workspace session and frozen owner authority. Verify concurrent image
calls do not contend on the chat lease and sessionless transcription cannot
borrow caller or creator authority.

When deduplicating, union scope assignments only after comparing each legacy
workspace row's exact model allowlist, allocator state and delegated manager.
Store differing values in the assignment-policy relation described after
§5.2; never union model allowlists or let one workspace's manager authorize
another. If a legacy value cannot be represented or its owner/scope is
ambiguous, abort the organization cutover before mutation and report a
content-free conflict class. Validate eligible-account/model decisions and
management principals for every assigned workspace before and after mapping.

Manual pins survive even when their account is unhealthy, paused, explicitly
disabled, or temporarily outside the current inference pool: preserve the
explicit target and make it wait under D-24, never fail over automatically.
The migration uses a narrowly scoped, owner-only backfill seam that is
unavailable to `opengeni_app`; it records the target reference but grants no
dispatch or lease authority. Runtime placement rechecks health, connection
scope, effective source, plan, model and accepted authority before every lease.
The migration test proves unhealthy and newly ineligible explicit pins survive
and then wait, while the restricted application role cannot use the backfill
seam.

#### Data move and cutover protocol

The M3 maintenance migration moves all organizations' Codex state in one
transactional, drained activation. The per-organization/provider switch is a
post-migration runtime gate, not permission to run old and new schemas or
writers concurrently.

1. Before deployment, take a consistent source inventory and publish counts by
   organization and legacy source table. Stop all API, control-worker, and
   turn-worker processes using the old Codex protocol; pass the complete old
   and new runtime-login list to the migration drain check. The migration
   refuses activation if any listed runtime writer remains. Preserve queued,
   waiting, checkpointed and scheduled work; drain processes, not logical work.
2. Under the migration transaction's owner-only RLS posture window, decrypt
   only through the existing codec-aware migration path and re-encrypt into
   `subscription_connections`. Deduplicate by organization, provider,
   provider-account identity and owner, choosing the healthiest canonical row
   deterministically. Keep its id where possible and write every merged legacy
   id to `subscription_connection_aliases`; fail on identity ambiguity rather
   than merge distinct owners. Reconcile per-workspace model allowlist,
   allocator and manager differences into assignment policy before dropping
   any duplicate row. Secrets are copied only inside the trusted
   codec boundary and never enter logs, counts, fixtures or diagnostics. Every
   refresh thereafter, including alias-based calls, serializes on the one
   canonical connection id.
3. Map health, plan/account metadata, labels, allocator eligibility, model
   access policy, `inference_pool` classification per assignment, quota/reset
   facts and provider-owned reset-credit state
   without turning unknown quota into exhaustion. Keep `connected_by` as audit
   metadata only. Map scope and workspace assignments per §5.2: workspace rows
   become workspace-scoped shared connections; Personal-workspace rows become
   the owner's personal connection and set that owner's personal-fallback
   preference and the effective workspace `personal_fallback_allowed = true`
   setting per §5.2; organization rows with a NULL allowlist become organization
   scope; non-NULL lists become the identical workspace set plus the existing
   Personal-workspace bit. `organization` mode disables local Codex inference
   through the setting but does not erase workspace scope or non-inference
   access such as an Apps designation; switching source later must restore the
   exact prior inference pool without rebuilding assignments. A canonical
   connection present in both legacy workspace and organization pools retains
   both assignment-policy memberships and one credential, quota and refresh
   lock.
4. Build settings from the effective legacy Codex source, using §5.2's exact
   `automatic`, `workspace`, `organization`, and `disabled` mappings. Map
   rotation only for the pool currently in effect: rotation off becomes
   `primary_first` (D-13) with the active legacy connection as primary;
   rotation on becomes `spread`. For `automatic`, preserve no explicit source
   override and admit every eligible workspace- and organization-classified
   shared connection. Where §5.2 gives a local account primary precedence,
   preserve that rotation/primary order for new work; an unavailable primary
   falls through to eligible organization connections before opted-in personal
   fallback. Explicit `workspace` and `organization` source values filter by
   their assignment classification. Keep the old `use_organization_accounts`
   field as a derived API/SDK projection only. Do not synthesize a workspace
   model allowlist or alter connection scope to emulate source selection.
5. Convert session pin and last-account columns into one
   `subscription_session_bindings` row. A manual pin is `explicit`; otherwise
   preserve the latest effective selected account as `automatic`. Resolve ids
   through aliases, derive the current model provider, and set
   `last_model_call_at` from the latest model-call fact; if no fact exists,
   preserve an unknown timestamp for core coldness semantics. Never bind to a
   deleted alias. Preserve an unhealthy/ineligible explicit target through the
   owner-only, non-dispatching backfill seam above; ordinary application writes
   remain subject to active-pool guards.
6. Move active leases with the same turn, holder and generation fence, mapping
   connection ids through aliases and preserving expiry. Move only the
   authoritative waiter per blocked turn/session, carrying generation,
   stable `waiter_id` (preserving the Codex UUID), `wake_revision`,
   `observed_wake_revision`, `next_check_at`, reset reason/time, retry state,
   blocked-turn generation and accepted-update link. Extend the M2 waiter row
   with these compatibility fields and a unique account-scoped waiter id before
   backfill; an activity whose history already contains the legacy waiter id
   must reconcile against the same id after activation.
   Collapse stale duplicate per-pool waiters deterministically and retain a
   bounded disposition diagnostic. Add the Codex entry to v2 accepted
   authority on live sessions, turns, scheduled-task authorities, system
   updates and outbox rows without changing deferred-provider v1 snapshots or
   existing v2 entries. For a legacy Codex `user` snapshot, derive the owner
   only from the exact owner-caused acceptance; preserve its frozen
   `authorityGeneration` only when the source resource authority is verified
   and still active, and transfer that generation to the canonical connection
   and its resource-authority row. Never substitute the current membership
   `authorization_revision` or mint new personal authority from current
   membership alone. If the source authority is revoked, stale, or cannot be
   tied unambiguously to the canonical owner/resource, backfill no personal
   authority for that accepted work; it may proceed only on currently eligible
   shared capacity. Ambiguous ownership aborts activation. Non-human acceptance
   gains no personal authority. Preserve any durable Codex source/credential-policy snapshot as
   secret-safe legacy decision provenance for recovery/audit and use it only to
   initialize the migrated binding or identify a pre-cutover in-flight lease.
   The snapshot is not new authority: `explicit_choice` exists only on the
   session binding; shared pool eligibility, source settings, model policy,
   health and entitlement are re-evaluated by the core before a new selection,
   lease renewal or dispatch. A transferred live lease may finish only the
   already-authorized in-flight provider call and cannot authorize its next
   call. Personal authority remains only in the immutable v2 authority value.
   Source changes, revocations and pin changes therefore take effect at the
   next core placement boundary without reviving the legacy selector. Also backfill Codex
   personal authority for live owner-caused accepted work whose account moves
   from a Personal workspace to a personal connection, only when the exact
   session owner, initiating human, organization membership and current
   authority generation are verified. Cover queued turns, live waits and
   causal continuations; exclude non-human acceptance and abort on uncertain
   ownership.
7. Before commit, validate explicit-account-context parity counts by
   organization and legacy source: source/target credential and secret
   readability, unique upstream identities, aliases, scope/assignments,
   per-workspace model allowlists, allocator eligibility and manager
   principals, effective mode/rotation, pins/bindings, Apps designations,
   leases, live waiter IDs/generations/revisions, and v2 authority coverage.
   Use migration-owner queries that actually see
   FORCE-RLS rows; zero-row backfill success is invalid. Any mismatch rolls
   back activation.
8. Declare `-- deployment-mode: maintenance`, open the documented `NO FORCE`
   window only around owner backfills and restore FORCE before commit. Allocate
   the then-next free ledger ordinal and use the repository renumber tool if
   the shared migration ledger has advanced. Register the migration at all
   three release-schema contract sites. No UI change is part of this migration.

After commit, start only cutover-aware binaries. Enable the Codex
organization/provider switch only after runtime-posture checks, explicit
connection-context parity, compatibility projections and workflow replay pass.
The switch may hold an organization on a core-disabled behavior only if the
new binary has an explicit safe maintenance response; it cannot route through
old Codex tables after migration. It supports staged activation and containment
among compatible new binaries, but does **not** make the release a rolling
per-organization old/new cutover. Switch-off must fail closed or use documented
core maintenance behavior, never resurrect the deleted decision path.

#### Workflow and public compatibility

Keep Temporal activity names, workflow signal names and arguments stable
wherever possible. Update activity implementations to peek both the new
provider-neutral waiter and legacy Codex waiter shape during replay; after
activation all new writes target the core. Preserve existing Codex signal
payload fields and add optional generation/wake-revision fields without
changing their meaning. The core waiter retains the legacy waiter UUID so a
workflow history that already recorded a pre-cutover `waiterId` can reconcile
against the migrated row; if an ID cannot be preserved, use a durable
organization/session/generation-fenced alias lookup, never a best-effort
session-only match. Preserve `next_check_at`, `observed_wake_revision` and
blocked-turn generation as well as the latest wake revision. Pin
`legacy-session-capacity-wait-history.json` in a
replay test against the new workflow/activity registry; assert it reaches the
same waiting, wake, resume and continue-as-new decisions without
nondeterminism. Also test the cutover seam where the legacy peek activity has
already completed before migration and its recorded activity arguments execute
in reconciliation afterward; history replay alone cannot prove that migrated
database state matches a recorded waiter id. Keep signal delivery outbox-backed
and idempotent across a crash between database wake and Temporal signal.

For `SUB-COMPAT-02`, keep all current Codex route paths, verbs, request fields,
response keys, status/error codes, SDK method names, exported types, React hook
names, session-indicator inputs and existing Codex event names. Translate
legacy IDs through aliases on reads and writes. Retain source values
`automatic|workspace|organization|disabled` and the legacy active-account,
usage, Apps, reset-credit and session-pin projections as adapters; canonical
internal writes use core ids and settings. Events are aliases of one committed
state transition, not separate truth. Never expose ciphertext, refresh
material or alias ownership details.

Compatibility is wire-shape compatibility, not preservation of superseded
authorization. In particular, Apps designation/clear uses the organization
administrator or that connection's delegated manager in any inference source
mode. Reset-credit prepare/redeem is a same-origin managed-browser action for
those same principals only; an acting-person agent, organization MCP call,
bearer, service, scheduled task or background agent is refused. Alias
resolution occurs before the same live management check, and the HMAC,
attempt/credit binding, provider idempotency and ambiguous-outcome recovery
remain unchanged. Add route tests for each allowed/denied principal through
both canonical and aliased IDs. Preserve the legacy permission checks on other
routes unless a separately specified contract requirement supersedes them.

#### One-way boundary and fix-forward

The migration commit is the one-way point: no pre-M3 API/worker binary may
start afterward, and no down migration or application rollback to legacy
Codex writers is allowed. Before activation, preflight, backups and the old
binary remain recoverable. After activation, recovery is forward-only: correct
the migration only if activation did not commit; otherwise ship a fix-forward
binary and, when needed, a narrowly scoped forward repair migration that is
idempotent, alias-aware and parity-checked. Keep affected organizations behind
the new-binary switch while repairing; do not copy rows back, drop aliases,
reset generations, clear live waiters, or re-enable `codex-rotation.ts`.
Preserve accepted prompts/checkpoints and let current workers resume them.
Deployment docs must give operators the stop/drain, runtime-role list, backup,
activation, post-start validation and fix-forward sequence.
The same implementation updates `codex-subscription-rotation.md` to a short
pointer to the shared subscription contract/design for superseded behavior,
and updates contract verification lines only for requirements covered by
passing production-path tests.

#### Focused implementation PR sequence

The provider-neutral runtime repository, operation leases, assignment-policy
relation, effective `inference_source` resolver, generic wait/recovery path and
gated placement-world foundation are delivered in the earlier M1/M2 PRs; they
remain non-authoritative for Codex while the provider switch is disabled. Keep
the remaining M3 implementation reviewable in five dependent changesets:
(0) this rolling-compatible additive precursor: nullable v2 accepted-authority
storage plus inactive exact-turn personal-placement and Codex refresh-write
helpers; no v2 reader/writer, data move, or gate enablement, and v1 remains
authoritative for every provider. Older workers continue unchanged. This
precursor also supplies the ownerless shared-only authorization routines
referenced by the already-merged gated foundation; those routines are exercised
against migrated PostgreSQL rather than left as fail-closed placeholders;
(1) the Codex chat selector plus credential materialization and refresh through
the shared core, dormant behind the disabled provider switch;
(2) the remaining Codex-specific consumers (compaction, transcription,
realtime, media, tool gateway and billing attribution) and their compatibility
route/SDK/event projections, still behind the switch;
(2b, "PR 3b") the remaining Codex writers, still dormant behind the switch:
connect and disconnect, organization-level reset redemption, personal
connections in their owner's views, and the v2 writers on every remaining
accepted-work carrier. It lands before (3), because main is continuously
deployable and (3) without it would leave Codex connect and disconnect
answering 409 for every organization;
(3) the drained maintenance migration: v2 backfill, cutover row activation, no
dual write, release-schema registration and deployment runbook; and
(4) deletion of the legacy Codex decision path once (3) has made it
unreachable. The selector and migration ship as one matched release and
activate only after the required drain. Retire legacy Codex executable paths in
M3; retain old tables only where needed for later provider cutovers or the
planned M6 schema cleanup.

The precursor corrects two authorization gaps found while reviewing the
already-merged gated foundation: the ownerless-session authorization function
was referenced but not defined, and its lease guard rejected the intended
ownerless shared-only path. It also defines (but does not activate) the v2
personal-placement helper. These repairs do not enable routing or change v1
authority; the exact provider cutover gate remains off until the drained step.

The earlier M2 runtime-store migration 0645 is maintenance-mode, although it
moves no records and opens no `NO FORCE` window: the standalone runtime-posture
contract is exact, so an older binary rejects the newly added FORCE-RLS
relations and grants. Drain old API, control-worker, and turn-worker processes
before applying 0645, then start only binaries that include its matching
runtime-posture and repository contract. The provider switch remains disabled;
it cannot make that schema change a per-organization rolling rollout. M3's
final migration remains the separate one-way Codex data-move and
switch-activation maintenance cutover.

Do not merge a partial Codex caller cutover that can strand Codex on the
core-disabled path. Each
implementation PR follows the repository's complex-change process: two
independent reviews (authorization/RLS and correctness/compatibility), validated
findings fixed, exact-head re-review, full green CI, head-SHA recheck, then
protected merge. Rerun only failed jobs for verified transient failures.

##### PR 1: Codex chat selector and credential materialization (dormant)

PR 1 implements inventory EP-T01..T08 for Codex chat turns only: turn claim
and model policy, placement, credential materialization, leases and dispatch
fencing, failure settlement, finalization, usage and release. The EP-T09/T10
wait, recovery and wake path is deferred to PR 2; until then a placement wait
fails closed (below). PR 1 is reachable only when an organization's Codex
cutover row is enabled, which no migration does before PR 3; the legacy
selector is unchanged when no row exists. Each strict default below is the
fail-closed reading of this plan and the contract where they were silent.

- **Gate.** No row: the legacy path, byte-for-byte. Disabled row: the turn
  fails with typed copy (`subscription_core_cutover_disabled`) and reads no
  legacy Codex table. Enabled row: the core places the turn. Placement,
  credential reads, refresh, quota observations and failure receipts re-check
  the gate in their own transaction, so switch-off fails closed mid-turn. At
  claim, an accepted Codex turn of an organization with any row no longer
  reads the legacy active-credential flag (the catalog provider is installed
  when enabled), and no turn of such an organization, whatever its model,
  resolves the legacy Codex Apps designation. The claim reads the row with the
  legacy read's bounded retry.
- **Accepted authority.** Placement reads only the exact turn's immutable
  `subscription_authority`; NULL is no personal authority. The owner tuple is
  the session's recorded owner and membership and the turn's initiating human,
  never a viewer, creator or live-membership inference. The core service
  actor shows the session owner as its initiating human for a
  service-initiated turn only so the owner's session rows are visible;
  personal access follows the stored turn human, which stays NULL, so a
  service turn never leases, reads or refreshes a personal connection. PR 1
  adds no v2 writer, so post-cutover turns run on shared capacity only.
- **Placement.** `withSubscriptionCorePlacementWorld` + `decidePlacement` over
  the turn's accepted product model only (provider `codex`), with
  cross-provider failover and fallback order forced off. Explicit choices run
  on their account or wait (D-24); stickiness uses the binding's
  `last_model_call_at`.
- **Lease.** The lease generation is the turn's execution generation and the
  holder is the existing per-attempt holder id. A retry of the same attempt
  reuses its live lease while the connection can still serve (an expired one
  is released and acquired afresh); any other holder of the same or a newer
  generation is fenced; an older attempt's live lease is never taken over
  before it expires (the core contract). That case
  (`subscription_lease_busy`) recovers the same turn with its own pacing, at
  the older lease's expiry plus up to five seconds of jitter and never more
  than one lease TTL, outside the provider recovery budget. Lease renewal is
  not fenced on the turn's current attempt, so the chain is bounded: the turn
  records when a consecutive lease-busy chain started (it continues only from
  the immediately previous execution generation), and after about three
  lease TTLs the turn stops with typed copy and an idle session. A database
  failure while recording that recovery keeps the turn recoverable, as on the
  provider recovery path. Legacy took over immediately; this is the stricter
  reading. Renewal, the pre-dispatch check
  and release run under the core service actor for the exact turn.
- **Binding.** Written only through the version compare-and-swap, only when
  the connection or model changes, preserving `choice` and `only_this_model`;
  a conflict retries placement at most three times. Ownerless sessions never
  write a binding (the database refuses one without an exact turn).
  Finalization advances `last_model_call_at` only after a model call that
  produced a response.
- **Events.** `codex.credential.selected` and `codex.account.switched` keep
  their payload shape and attempt-fenced idempotency; the previous account
  comes from the binding and `strategy` is the rotation mode. The legacy
  `sessions.codex_last_credential_id` pointer is never written with a core id.
- **Credential plaintext (the PR 3 mapping target).** `credential_encrypted`
  is the same `encryptEnvironmentValue` blob as the legacy tables over the JSON
  object `{access_token, refresh_token, id_token}`; `provider_account_id` is
  the ChatGPT account id, `provider_state.isFedramp` the FedRAMP flag (absent
  means false) and `plan_type` the recorded plan. The bearer snapshot keeps
  the legacy `CodexCredentialTokenSnapshot` shape; its `credentialVersion` is
  the connection's `refresh_generation`, which fences quota observations. A
  credential that cannot be decoded fails with fixed text and no cause, so no
  plaintext reaches an error message (the legacy decoder is fixed the same
  way).
- **Reads and refresh.** Every credential read requires the exact accepted
  turn, the live lease and, for a personal connection, the frozen v2 entry
  (through the v2 personal-placement helper). Ownerless turns never read a
  personal or people-scoped connection. Refresh goes only through the
  begin/persist seam, persisting immediately after the provider returns.
  Concurrent refreshes in one process share one provider call per connection
  and generation, but only connection-level outcomes (refreshed, superseded,
  revoked sign-in, provider error) are shared; a lost lease or refused
  authorization belongs to the turn that hit it, and a waiting turn refreshes
  under its own lease instead. A permanent OAuth refusal marks the connection
  `needs_relogin` through `fail_subscription_codex_refresh` (migration
  0668), which consumes the same one-shot authorization as persist and writes
  under the refresh-generation compare-and-swap.
- **Personal authority repair.** The lease guard and
  `begin_subscription_codex_refresh` authorized personal connections only
  from the v1 Codex snapshot, so a v2-authorized personal placement could
  never lease or refresh. Migration 0668 makes
  `authorize_subscription_personal_access` use the exact v2 entry (owner
  membership and current authority generation, personal connections allowed)
  for Codex once its cutover is enabled. A Codex cutover row that exists but
  is disabled grants no personal authority at all. Every other provider, and
  Codex while no cutover row exists, keep the v1 check.
- **Wait.** No core wake delivery loop exists yet, so a placement wait fails
  the turn with typed copy (`subscription_capacity_unavailable` with the wait
  reason and known reset), leaves the session idle for the next message and
  wakes a waiting parent, instead of parking on a waiter nothing would wake.
  No core waiter row is written. (Superseded by PR 2a, below: the turn now
  parks on a durable core waiter.)
- **Failure, usage and release.** Core turns never reach the legacy Codex
  settlement. Lease loss recovers the same turn (`codex_lease_lost`), as for
  Claude and SuperGrok. Quota and rate-limit refusals record a
  generation-fenced quota observation and a turn failure receipt on the leased
  connection (both require the live lease and the enabled gate), then settle
  through the existing typed copy. A revoked sign-in, a 403 that survives
  refresh, or an explicit plan-entitlement refusal records a receipt and fails
  the turn with typed copy (`subscription_account_refused`), idling the
  session and waking a waiting parent. Losing access mid-turn (the connection
  or the turn's authority over it is no longer visible, enabled or usable) is
  a distinct typed error with its own copy, never reported as a revoked
  sign-in. Usage headers become a quota
  observation at finalization, and the lease is released through
  `releaseCurrent()`.
- **Consumers still on PR 2.** A core Codex compaction turn fails closed
  (`subscription_core_unsupported`); the Codex image tool is not exposed on a
  core turn; the worker resolves no legacy Apps designation for a cutover
  organization; the legacy model-connection check is skipped because placement
  already enforced the connection and workspace model policy. In-turn remote
  compaction and title generation use the core bearer and touch no legacy
  table.

Deferred to PR 2 (all behind the same gate; PR 2a below takes the first
six items, PR 2b and PR 2c the rest):

- core capacity waiters, the wake delivery loop and both-shape workflow
  reconciliation (EP-T09/T10);
- in-turn re-placement after a refusal, with the per-turn failover bound;
- connection health and quarantine for 403 and plan-entitlement refusals
  (today the connection stays active and sticky placement can return to it;
  the next turn fails again with the same typed copy);
- the v2 accepted-authority writer at acceptance;
- persisting the plan carried by a rotated id_token (the refresh seam has no
  plan column);
- re-selection points (compaction completed, model changed);
- the Codex Apps designation on the core;
- the "Running on" session display and the legacy
  `sessions.codex_last_credential_id` pointer, which core turns do not write;
- compaction, transcription, realtime, image/video, reset credits, billing
  attribution and the route/SDK/React compatibility projections.

PR 3 precondition: `apps/api/src/workspace-tool-gateway.ts` and the
`packages/core` capability overlays still resolve the legacy Codex Apps
designation and active-credential state. PR 2 must move them to the core (or
gate them on the cutover row as the worker does) before PR 3 enables any
organization. PR 2b moves both, and the worker claim, onto the core
designation (see "PR 2b" below).

Migration 0668 follows the precursor's 0667; renumber with
`scripts/renumber-migration.ts` if the shared ledger moves again.

##### PR 2a: Codex chat waits, wakes, re-placement and health (dormant)

PR 2 is split. PR 2a completes the Codex chat path on the core: EP-T06
(in-turn re-placement), EP-T09/T10 (durable waits and wakes), connection
health for refusals, re-selection points, plan persistence on refresh, and
the v2 accepted-authority writer (EP-T11..T15). PR 2b takes everything else
from the PR 2 list: compaction, transcription, realtime, media, the Apps
gateway and designation, reset credits, billing attribution and the
route/SDK/React compatibility projections. Everything below is reached only
with an enabled Codex cutover row; without a row the legacy path is
unchanged apart from a few extra reads: one indexed read of the (empty) core
waiter table per workflow peek, `getCodexCapacityWait` and legacy Codex
reconcile; one cutover-row read per non-edit human prompt and per non-child
initial message (after a once-per-process `to_regprocedure` check that the
writer routine exists); and one read of the causal turn per pure
goal-continuation claim (not gated on the cutover, since the copy is a
no-op when the causal value is NULL). Migration 0669 is rolling: nullable
columns on tables the legacy path never reads, a trigger that only acts on
the new `health_retry_at` column, and `SECURITY DEFINER` routines that
refuse unless the cutover is enabled. It directly follows the stack's
0667/0668 in dependency order; if those are renumbered again, this branch is
rebased onto them and 0669 is renumbered with `--next` (no gaps), so it
always stays after them.

- **Waiter row.** A placement wait no longer fails the turn: the attempt is
  closed and the same logical turn parks on the session's
  `subscription_capacity_waiters` row, with the legacy Codex arm's lock order,
  events (`codex.capacity.waiting`, `session.status.changed`), tool closure,
  child "waiting for capacity" notice, goal fence (new `goal_id` and
  `goal_version` columns) and false-resumption budget (the same
  `codexCapacityRecoveryV1` turn metadata, ten resumptions with persisted
  backoff). The row exists only while the turn waits: resuming or
  superseding deletes it (and, by cascade, its outbox rows), so a timer or
  signal that still carries an older waiter id finds nothing and is stale.
  The next check is the earliest reset placement knows (authoritative); else
  the earliest end of a health quarantine, if sooner than the bounded
  control-plane backoff (1 minute doubling to 15). A check never calls the
  provider; it only evaluates placement.
- **Reconcile.** Two steps. Placement is evaluated for the exact accepted
  turn without leasing or writing (`evaluateSubscriptionCoreCodexPlacement`),
  then the waiter is settled under the session row locks: `run` makes the
  blocked turn `recovering` (its next attempt places and leases normally);
  `wait` updates the reason and schedule and acknowledges only the wake
  revision the evaluation saw, so a capacity change that lands during the
  evaluation is checked again at once; a turn whose accepted identity or
  authority no longer admits core use is superseded
  (`subscription_access_revoked`); a disabled cutover keeps the work parked
  with the bounded backoff (maintenance behavior, never the legacy tables).
  Pause leaves the waiter alone; a changed goal, session or turn supersedes
  it at the next reconcile.
- **Steer and Cancel.** As with the legacy waiter, the Steer and Cancel
  transactions end the wait themselves: they delete the blocked turn's core
  waiter (and, by cascade, its pending outbox rows) in the same commit that
  supersedes or cancels the turn, so the Steer turn runs at once and a
  cancelled session receives no further wakes. As defense in depth, the
  workflow peek and `getCodexCapacityWait` treat a core row that no longer
  belongs to the session's active turn in `waiting_capacity` as an immediate
  check, whose reconcile supersedes and deletes it without placing; the
  workflow never sleeps on such a row until its next check.
- **Workflow compatibility.** The session workflow is unchanged. A core
  waiter is addressed by the legacy Codex reference
  `{ waiterId, generation, nextCheckAt, wakeRevision }` without a `provider`
  field, so activity names, signal names and argument shapes are identical.
  `getCodexCapacityWait`, `reconcileCodexCapacityWait` and the
  `peekSessionWork` capacity branch look the waiter id up in the core table
  first and fall back to the legacy Codex table; SuperGrok and Claude waits
  never consult the core. An unobserved wake revision is reported as an
  immediate check, which carries a lost signal across restart and
  continue-as-new. The pinned legacy history and recorded core histories
  (signal before peek, peek before signal, continue-as-new with a pending
  wake, outbox retry) replay against the current bundle
  (`test/integration/subscription-core-codex-wait.integration.ts`).
- **Wakes.** `wakeSubscriptionCoreCodexCapacityWaiters` advances the wake
  revision of every waiting core Codex waiter of the account. It enumerates
  the organization's workspaces with the existing content-free
  `list_organization_codex_workspace_ids` (since §5.3 PR 0c, Codex's wrapper
  of the provider-keyed `wakeSubscriptionCoreCapacityWaiters`, which uses
  `list_organization_subscription_workspace_ids`) and writes in the trusted
  empty-subject worker scope the outbox policy requires, never through legacy
  active pointers. Each woken waiter gets a provider-neutral outbox row and a
  generic session workflow wake in the same commit; the generic wake is the
  crash-safe backstop the global dispatcher always delivers. Typed delivery
  claims due rows (claim-generation fenced), signals `codexCapacityChanged`
  with the waiter's wake revision through `signalWithStart`, then marks the
  row delivered; a failed signal retries after 1 second doubling to 5
  minutes and is given up after 8 attempts (the generic wake still reaches
  the workflow). The retry is opportunistic, not scheduled: a row whose
  retry time has come is delivered by the next wake or reconcile that drains
  its workspace (every core reconcile drains its workspace's due rows first,
  which also repairs a crash between the database wake and the signal); until
  then the generic wake committed with the row is what reaches the workflow.
  A host without a typed signaler claims nothing and leaves the rows pending
  for a worker that has one. Producers in
  this PR: a usage observation that ended a stored exhaustion
  (finalization), a quarantine that returned to service, and a plan change
  on refresh. A reached reset is the waiter's own timer. Wakes are
  account-wide hints (no per-connection filter); every waiter re-places
  under its own accepted turn, and the workflow's jitter spreads the herd.
  Binding/pin, assignment and administrator health changes belong to the
  PR 2b route adapters, which must call the same function.
- **In-turn re-placement and bound (EP-T06).** A definitive refusal on a core
  turn records a failure receipt and the state that keeps placement away from
  the connection (below). After a durable checkpoint the lease is released
  and the same accepted turn recovers with a new attempt
  (`codex_credential_failover`), whose placement chooses again: another
  eligible account (the binding moves and the existing
  `codex.account.switched` is emitted), or a durable wait. An explicit choice
  never fails over: its next placement waits on the chosen account (D-24).
  The contract requires a bound but fixes none; **the bound is four refusals
  per turn (at most three switches)**, counted over every refusal by any
  account including repeats (the receipt keeps a per-connection `refusals`
  count), so a turn cannot alternate between failing accounts (SUB-FAIL-11).
  The recovery detail keeps the legacy switch counters (`failoverCount` n of
  `maxFailovers` 3); the refusal that reaches the bound fails the turn with
  `subscription_failover_exhausted`, `refusals: 4, maxRefusals: 4`, and an
  idle session. The explicit-pin rule itself is PR 1's placement; PR 2a's
  Postgres suite also proves a pin refused mid-turn (a 403) re-places to a
  `pinned_account_unavailable` wait with the quarantine's end, never to
  another account. A refusal whose
  receipt could not be recorded, or whose checkpoint did not become durable,
  is not replayed: the turn keeps PR 1's typed terminal copy. Mid-turn loss of
  access (`subscription_core_access_lost`) stays terminal, the stricter
  reading; re-placing it is left to a later change.
- **Connection health.** Written only by `SECURITY DEFINER` routines that
  require the enabled cutover, the exact accepted turn's session-access
  capability in the same transaction and that turn's live lease on the
  connection, under the refresh-generation compare-and-swap of the refused
  credential (a refusal seen with an older token family cannot quarantine a
  renewed one). They reuse the existing one-statement `codex_refresh_write`
  capability; the application role has no other write path.
  - A 401 that survived refresh marks the connection `needs_relogin`
    (cleared only by a new sign-in; the refresh seam already marks a refused
    OAuth refresh).
  - A 403 refusal (only a 401 triggers a refresh first) sets
    `status = 'error'` with `health_retry_at` one hour later. The next
    placement or waiter check that could lease the connection returns due
    quarantines to service and wakes the account's waiters; a waiter's next
    check includes the quarantine's end. The recovery routine filters
    explicitly rather than relying on row-level security (its owner may
    bypass it): shared rows by `subscription_connection_visible` for the
    turn's workspace, personal rows only for the owner's own turn (the
    stored turn human is the owner, so a service or API-key turn in the
    owner's session never qualifies) whose frozen v2 authority names the
    row's owner membership and authority generation, exactly as placement
    decides. Only quarantines this mechanism wrote are cleared: a
    `BEFORE UPDATE` trigger drops `health_retry_at` whenever another write
    changes the status or the error without setting it (an administrator, a
    sign-in failure, or a failed refresh that marks the connection; a
    successful refresh changes neither, so the quarantine stands), so an
    unrelated later `error` is never cleared by a leftover retry time.
  - A plan-entitlement refusal becomes a 24-hour cooldown of that model on
    the connection's quota state (legacy 0524 parity), so placement excludes
    only that model there and a waiter learns when it returns.
- **Plan persistence.** `persist_subscription_codex_refresh_with_plan` is the
  persist seam plus the plan from the rotated id_token, under the same
  one-shot authorization and compare-and-swap; a missing plan keeps the
  recorded one. A changed plan clears the connection's model cooldowns in
  the same commit and the worker wakes the account's waiters.
- **Re-selection points.** `model_changed` (the turn's accepted model is not
  the bound model) and `compaction_completed` (the session's latest durable
  `session.context.compacted` or `session.context.cleared` event occurred
  after the binding's last recorded model call; an unknown input-token count
  is not a compaction) are passed to placement and to waiter evaluation.
  Both release only an automatic binding.
- **v2 accepted-authority writer (EP-T11..T15).** With the Codex cutover
  enabled, acceptance freezes the Codex entry of
  `session_turns.subscription_authority` through
  `subscription_codex_acceptance_authority_v2`; without an enabled cutover
  nothing is computed and the column stays NULL (v1 authoritative). A
  personal entry is written only for exact owner-caused acceptance: the
  authenticated request subject (or, in the trusted session-start context,
  the session's frozen subject creator) is the session owner, the owner
  membership is active, and the session is private or in the owner's
  Personal workspace. The generation is the single authority generation
  across the owner's own personal Codex connections that can serve without
  a human (`active`, or `error` under a time-bound quarantine), each joined
  to its exact active authority as placement joins it; other providers'
  authorities and connections waiting for a new sign-in or disabled do not
  count. When those Codex connections still carry different generations (a
  re-grant not yet applied to all of them), or there are none, the value is
  empty (strictest: never a wider grant). Every other acceptance writes the
  empty v2 value. Acceptance calls the routine only once
  `to_regprocedure` finds it, so an enabled cutover row on a database that
  predates 0669 writes nothing instead of failing the prompt.
  Claude and SuperGrok keep v1. Coverage:
  - human prompts (`submitHumanPromptInTransaction`): resolved for the human;
    an edit copies its source turn's value; operator, service and API-key
    actors get the empty value;
  - the initial session message (`initializeSessionStartAtomically`):
    resolved for the owner creator; a child session's first turn gets none;
  - goal continuations: a delivery made only of goal continuations copies
    its exact causal turn's value when that turn's human is this turn's human
    (the claim derives the continuation's human from that causal turn, so the
    human check is a defensive fence rather than a reachable branch).
  Kept empty (shared capacity only) and left to PR 3, with the reason:
  agent messages and Steer (EP-T14 asks for the receiving session's value,
  which has no single frozen v2 source yet); batched internal updates and
  child-result notices; child agents' first turns (EP-T13); scheduled tasks
  and their firings (EP-T15: `scheduled_tasks`,
  `scheduled_task_revision_authorities`, `session_system_updates`, the outbox
  and `sessions.initial_*` have no v2 column yet); compaction turns (moved
  with compaction in PR 2b).

Known gaps after PR 2a: an ownerless session has no binding, so its
re-placement emits no `codex.account.switched`; wakes are not filtered by
connection; the core reconcile acknowledges at most the revision it
evaluated, so a burst of wakes may cost one extra check; the "Running on"
display and the legacy pointer stay PR 2b; the PR 3 precondition above
(gateway and capability overlays) is unchanged.

##### PR 2b: Codex Apps, session display, route projections and wakes (dormant)

PR 2b is split again along a clean seam. **PR 2b** (this change) takes the
Apps designation with the tool gateway and capability overlays, the "Running
on" session display and the legacy pointer, the route/SDK/React compatibility
projections and the wake triggers for pin, assignment and administrator health
changes. **PR 2c** (stacked on PR 2b) takes compaction turns' accepted
authority, transcription, realtime, image/video, reset credits, usage
refresh and billing attribution, which share a connection-level credential
seam that PR 2b does not need. Everything below is reached only with a Codex
cutover row. Migration 0670 is rolling: one widened capability CHECK on the
transaction-local capability table and `SECURITY DEFINER` routines that return
nothing unless the account's Codex cutover is enabled.

- **Disposition.** Every Codex route, the tool gateway, the capability
  overlays and the worker claim read the account's cutover row first
  (`readCodexCutoverDisposition`). No row: the legacy code runs unchanged,
  after one extra primary-key read. Disabled row (maintenance): Codex routes
  answer `503 upstream_unavailable` with `details.reason =
  subscription_core_cutover_disabled`, no Apps designation resolves, session
  reads show null Codex pointers, and nothing reads a legacy Codex table.
  Enabled row: the core handlers below. The public error envelope is reused
  (no new `ErrorCode`), so `check.ts` sees no contract change.
- **Apps designation (PR 3 precondition).** Apps load by designation, never
  through placement (§6.3). `subscription_codex_apps_designation_target`
  returns the designated connection only while the designation still names
  it, the connection is a shared Codex subscription connection, and it is
  organization-scoped or assigned to this exact workspace. Decision (strict
  fail-closed): a people-scoped or personal designation resolves nothing,
  even though the merged 0642 write policy can store one, because Apps serve
  every caller in the workspace, including ownerless and service sessions
  and the tool gateway, which may use organization or workspace capacity
  only. That helper returns a full connection row, so it is never executable
  by the runtime role: 0670 and role provisioning revoke it after the
  schema-wide grant, and the runtime posture check rejects a runtime role
  that can execute it. On top of it:
  `resolve_subscription_codex_apps_designation` (id and health only),
  `read_subscription_codex_apps_credential` (ciphertext only while active)
  and `begin/persist/fail_subscription_codex_apps_refresh`, which take the
  same per-connection advisory key as chat refresh (so Apps and chat
  refreshes of one connection serialize), persist only under the
  refresh-generation compare-and-swap through the existing one-statement
  `codex_refresh_write` capability (widened to allow a workspace-scoped write
  with no session or turn), and mark `needs_relogin` on a permanent OAuth
  refusal. Each request rechecks the designation under the existing
  `codex-apps-settings:<workspace>` advisory lock that designate/clear also
  take, so a clear cannot commit between the recheck and the request.
  `apps/api/src/workspace-tool-gateway.ts`, both `packages/core` overlays
  (`buildCapabilityCatalog` and the runtime capability settings) and the
  worker claim use `resolveCodexAppsDesignationForRun` (legacy designation,
  core designation, or none); `resolveCodexAppsCredentialIdForRun` is now
  legacy-only and returns nothing for an organization with any cutover row.
  The designate route authenticates the managed human before it reads the
  cutover row, so an unauthenticated caller learns nothing about it.
  Designate/clear on the core use the designation table's own policy: an
  organization administrator, or a workspace administrator for a connection
  that workspace manages, in any inference source mode. The core row is
  deleted on clear, so the projected version returns to 0. Decision: a new
  designation's version is the transaction-clock microsecond (never below
  the stored version + 1), so it is greater than every earlier designation
  of that workspace (designate and clear serialize on the settings lock) and
  a stale clear always conflicts instead of removing a newer designation; no
  tombstone or schema change is needed. Designate refuses (as not found,
  404) every target the resolver could never serve: a personal connection,
  a people-scoped shared one, or a workspace-scoped one not assigned to this
  workspace, so settings never show an inert designation; the catalog still
  requires an active connection. The in-process Apps refresh flight is keyed by
  workspace, connection and refresh generation, because one
  organization-scoped connection can be designated by several workspaces
  and one workspace's `unavailable` must never reach another's request.
  Authorization in every 0670 routine is an explicit predicate (account and
  workspace equal the caller's context, enabled cutover, a designation row
  for this workspace naming the connection, shared Codex subscription
  connection, organization scope or an exact workspace assignment, active
  status, and begin's one-shot authorization for persist/fail), never row
  visibility, so the routines are equally safe when their owner bypasses RLS
  (a superuser-owned routine) and when it is subject to FORCE RLS; the
  authorization tests run under both the shared template and an
  owner-migrated database. Gate-off cost: `resolveCodexAppsDesignationForRun`
  takes what the caller knows (the organization, skipping the workspace
  lookup; the cutover disposition, skipping the cutover read). The claim
  reads its cutover row once and resolves the designation once for both the
  capability overlay and the Apps credential; the overlay resolves nothing
  while Apps are off for the deployment.
- **Running on and the legacy pointer.** `GET .../sessions/:id/codex-accounts`
  projects from the session's core binding, the active turn's live core
  lease and the workspace's core pool: a running turn shows its leased
  connection, a waiting turn only an explicit choice. Every response that
  returns a Session (GET, list, lineage ancestors and children, and every
  mutation that answers with the session, through the routes' one shared
  response projection; the organization-wide session list; and MCP
  `session_get`) fills
  `codexPinnedCredentialId`/`codexLastCredentialId` by disposition
  (`apps/api/src/codex-session-pointers.ts`): legacy ids unchanged without a
  row; from the binding (explicit choice and bound connection) with an
  enabled row, nulls for a core session without a binding; nulls in
  maintenance. A session read never fails on Codex state: an unreadable
  cutover or binding shows nulls and is logged. `sessions.codex_last_credential_id` is still never
  written with a core id (it carries a legacy-table guard), and legacy reads
  of it are unchanged for organizations without a row.
- **Route projections (SUB-COMPAT-02).** Same paths, verbs, request fields
  and response keys, from `subscription-core-codex-compat.ts` under the
  caller's own RLS context: workspace status, accounts (with Apps), source
  (get/set), activate, rotation settings, rename and allocator; organization
  accounts, activate, settings and rename; session pin. Mappings: the
  account pool lists shared subscription connections in the workspace's
  scope and in its effective pool, as legacy did (nothing while Codex is
  disabled there; only workspace-classified connections for the workspace
  source and only organization-classified ones for the organization source;
  both shared pools for automatic, which the core admits; an administrator's
  wider visibility is filtered explicitly);
  `source` is `workspace` when the connection has a workspace-pool
  assignment here (or, without assignment rows, is managed here);
  `activeCredentialId` is the effective primary connection; rotation on is
  `spread`, off is `primary_first` (D-13); source modes are the workspace's
  Codex provider override (`automatic` removes it, `workspace`/`organization`
  set `inferenceSource`, `disabled` sets `enabled = false`), never connection
  scope; the allocator toggle is the connection's `allocator_enabled` with
  the legacy optimistic concurrency on `allocator_version`. Workspace
  activate, rename and allocator accept only a connection in the
  workspace's projected pool (the pool the accounts route lists), and
  organization activate and rename only an organization account (shared,
  managed by no workspace), as legacy did; both are checked before anything
  is written. Settings writes update the existing row in place. Decision: a
  missing organization row is inserted with the defaults the settings
  resolver applies to absent values (empty rotation, providers and fallback
  order, no cross-provider failover, personal connections allowed, no
  personal fallback), because the organization row's CHECK requires them;
  an upsert's proposed row would be refused before ON CONFLICT. A workspace
  rotation override carries the effective primary (the organization's while
  rotation is inherited), so toggling rotation never drops the account
  unpinned sessions prefer. Status readiness
  comes from the core pool with no live provider model probe (`valid` means
  a serviceable account exists; `models` is the configured catalog), because
  a connection-level credential read for the API belongs to PR 2c. A session
  pin writes the binding (`explicit`, or back to `automatic` without touching
  the connection so an unhealthy connection does not block "auto"), through
  the binding guard: the connection must be active and eligible for that
  session, and a personal connection only in its owner's own session. It
  emits the legacy `codex.account.selection.changed` receipt under the
  legacy pin's session-events lock contract (the canonical session lock
  without the workspace control prefix, since a preference change admits no
  inference and waiter reconciliation rechecks Pause). The pin locks
  the binding row (`FOR UPDATE`) before its version compare-and-swap, so a
  running turn's concurrent binding write makes it wait, not report the
  choice as not found. Management
  authority is the core tables' policies: an organization administrator, or
  a workspace administrator for what that workspace manages (stricter than
  the legacy `connections:write` alone, which the route still requires).
  SDK and React types are unchanged because the wire shapes are.
- **Wakes.** Pin, allocator, primary, rotation and source changes return a
  wake that the route delivers after commit through PR 2a's
  `wakeSubscriptionCoreCodexCapacityWaiters` (workspace-scoped for workspace
  changes, account-wide for organization changes, and session-scoped for a
  session pin, which wakes only that session's waiter as legacy did, with
  the same outbox and generic-wake mechanics). No existing Codex route edits
  workspace assignment; the M5 scope editor must call the same wake. A
  failed wake never fails the committed change (every core waiter has its
  own bounded recheck, 1 minute doubling to 15) and is logged.
- **Not served on the core yet** (typed `409 conflict` with
  `details.reason = subscription_core_route_unsupported`, no legacy state
  read): live usage reads and refresh, the overview and reset-credit
  prepare/redeem (all served by PR 2c); connect start/poll, disconnect one
  or all (PR 3). The connection access editor (models and workspaces) was
  the last such route; migration 0702 serves it on the core (see "Codex
  access editor" below) and the typed refusal is gone.

##### Codex access editor (migration 0702)

`PUT .../model-connections/codex/:id/access` writes the core in one
transaction, guarded by a dedicated `access_version` (the row `version` also
moves on every credential refresh, which would make routine refreshes look
like edit conflicts). At organization scope, "every shared and Personal
workspace" is `organization` scope; anything else is `workspaces` scope over
the chosen shared workspaces (all of today's for "all, including new ones")
plus every Personal workspace when allowed, with matching organization-pool
rows and the owner-only auto-assignment row from 0689 kept as the reach for
workspaces created later (read and replaced only through
`subscription_codex_reach` / `set_subscription_codex_reach`, organization
administrators only; since §5.3 PR 0c these wrap the provider-keyed
`subscription_core_reach` / `set_subscription_core_reach`). A workspace's
own local copy keeps its assignment and
workspace-pool row whatever the organization chooses. In a workspace, a
workspace administrator changes only the models of the account that
workspace manages (the scope guard admits exactly that change). The route
delivers an account-wide wake after commit. An organization rotation switch
also switches the organization-pool copies and the reach's copy.

Known gaps after PR 2b: personal connections are not listed in any account
pool view (their rows are visible only inside the owner's exact accepted
turn), so a private session running on one shows its id in
`currentSelection` but a null `currentAccount`; plan-entitlement cooldowns
are not projected into `planExcludedModels`; the projections do not show the
legacy plan-change history.

##### PR 2c: compaction, media, transcription, realtime, usage and billing attribution (dormant)

PR 2c (stacked on PR 2b) moves the remaining Codex consumers that need a
connection-level credential outside the chat-turn lease, including reset
credits and the overview. Everything is
reached only with a Codex cutover row; without one the legacy code runs
unchanged after at most one extra cutover-row read (transcription
availability without an account in its context also reads the workspace row
to find the account). A disabled row is maintenance: these consumers fail
closed and read no legacy Codex table. Migration 0671 is rolling: one widened
capability CHECK on the transaction-local capability table, `SECURITY
DEFINER` routines that return nothing unless the account's Codex cutover is
enabled, and one added branch in the operation-lease guard.

- **Connection-level credential seam (0671).**
  `read_subscription_codex_connection_credential` and
  `begin/persist/fail_subscription_codex_connection_refresh` read and rotate
  one Codex subscription connection for an explicit account/workspace
  context. With an operation id they require the caller's exact live
  `subscription_operation_leases` row (operation, attempt, holder,
  generation, connection), read under the caller's own row-level security;
  a stale generation, holder or attempt can neither read, renew, refresh nor
  release. A turn-bound operation sees the connection through that exact
  accepted turn's visibility (a personal connection only under the turn's
  frozen v2 entry); a session-bound or sessionless operation, and a read
  without an operation (usage), are limited to shared organization- or
  workspace-scoped connections in the workspace's scope. Refresh takes the
  same advisory key as chat and Apps refresh (`subscription-refresh:<id>`),
  persists only under the refresh-generation compare-and-swap through the
  existing one-statement `codex_refresh_write` capability (minted in the
  workspace-only form 0670 added), and marks `needs_relogin` on a permanent
  OAuth refusal. Like the Apps seam it does not persist the plan carried by
  a rotated id_token (chat refresh does).
- **Compaction turns (EP-T16).** A core compaction turn places, leases,
  refreshes and settles exactly like a chat turn; the fail-closed branch is
  gone. The born-running compaction turn copies the immutable v2
  `subscription_authority` of the turn it compacts after (NULL without a
  cutover, so legacy is a no-op; a session with no started turn gets none).
  An existing `remote_v2` session keeps its Codex model lock because PR 1
  placement uses only the accepted model with cross-provider failover off.
  Decision: a core placement wait does not park compaction on a capacity
  waiter. As on the legacy path, the compaction turn is cancelled with
  `requestPreserved: true`, reason `subscription_capacity_unavailable` and
  the wait reason, and the session goes idle until its next work. The rest
  of the compaction path (remote compaction, history sanitization, usage)
  already ran on the core bearer and reads no legacy table; the serving
  credential id it passes is the core connection id, used only for the
  content-free account hash.
- **Image operations (EP-T17, EP-N08..N10).** A core turn exposes the Codex
  image tool again. Placement is the strictest available: the turn's own
  live chat connection, under the turn's accepted authority. Each call holds
  its own `image` operation lease keyed by the ledger's turn/tool-call
  operation id (stable across retries), holder `image:<attempt>:<call>` and
  the turn's execution generation, and renews it as the pre-dispatch fence.
  The lease is taken inside the ledger's `provider_started` window, so a
  lease that cannot be taken (busy, refused, cutover off) is a verified
  pre-dispatch rejection that returns the ledger row to `prepared`; nothing
  is reissued after an uncertain upstream write. The chat-turn lease and the
  session binding are never read or written, so concurrent image calls do
  not contend with the chat turn or each other. Video (EP-N11..N14): no
  Codex video adapter exists and no video path reads Codex state, so nothing
  changes.
- **Transcription (EP-N01..N04).** On the core the Codex provider is a
  sessionless operation for the authenticated caller with an explicit
  account/workspace context: candidates are the workspace's shared
  organization- or workspace-scoped connections that are active, allocatable
  and in the effective inference pool, primary first. Each request takes a
  `transcription` operation lease (generation 1, holder
  `transcription:<request id>`), renews it before each upstream request and
  releases it afterwards; a 401 permits one forced refresh and retry, as on
  the legacy path. Decision: personal connections are refused for
  transcription (the M2 guard already requires an exact turn for personal
  operation leases, and no frozen owner authority exists for a sessionless
  request); a people-scoped shared connection is refused for the same
  reason. Provider ordering selects the initial provider only: once the
  core provider is selected, every failure is `fallbackSafe: false`, so the
  audio is never retried through another provider. Subscription
  transcription stays non-chargeable (the provider has no deployment
  funding). Availability is "a candidate exists"; maintenance reports
  unavailable.
- **Realtime (EP-N05..N07, EP-S17).** Each realtime negotiation resolves the
  session's recorded owner (never the viewer), places one shared
  organization- or workspace-scoped connection (the session binding's
  explicit choice first, then the effective primary, then pool order,
  preferring a plan with voice), and holds a `realtime` operation lease
  (session-bound, no turn) through negotiation, with the operation renewal
  as its pre-dispatch fence and refresh under the per-connection lock. The
  broker, client protocol and HTTP error translation are the legacy ones; a
  fence refusal surfaces as `credential_unavailable`; maintenance as
  `subscription_disabled`. The chat binding is never written. Decision:
  realtime uses shared capacity only, also for an owned session (the guard
  admits personal connections only for an exact turn). 0671 adds one guard
  branch so an ownerless session's realtime operation (no turn, no
  initiating human) may lease shared organization- or workspace-scoped
  capacity, matching ownerless turns; an ownerless session cannot borrow a
  person's context. Catalog readiness for Codex Live on the core is "a
  candidate exists in this workspace"; maintenance is not ready.
- **Usage (EP-N21..N23).** Live usage (`GET .../codex/usage`, the effective
  primary), per-account usage (by canonical id or legacy alias) and the
  batched refresh run through the connection seam with the caller's
  explicit organization/workspace context, read `/wham/usage`, and record the
  windows as a quota observation fenced on the refresh generation of the
  bearer that read them (`applyQuotaObservation`; an older generation does
  not apply). An observation that ends a stored exhaustion wakes the
  account's core waiters through PR 2a's wake. Response shapes and 404 copy
  are the legacy ones. Plan and reset-credit summaries in the usage body are
  returned but not persisted on the connection.
- **Billing attribution (EP-N19..N20).** `recordModelCallFact` takes an
  optional `connectionId`, written (and coalesced on conflict) into
  `model_call_facts.connection_id`. Core Codex turns pass the leased core
  connection for streamed responses, the aggregate fallback, compaction
  summaries and session titles; legacy and non-subscription calls leave it
  NULL. The subscription-use billing bypass is unchanged.

- **Reset credits (EP-N18).** Prepare and redeem keep their routes,
  payloads, HMAC confirmation, single-use ledger fences and
  ambiguous-outcome recovery, over the same `codex_reset_redemption_attempts`
  ledger (it has no foreign key on `credential_id`, so it holds the canonical
  core id; legacy ids kept as canonical by the drained migration keep their
  in-flight attempts and upstream idempotency keys). The route id may be the
  canonical id or a legacy alias; it resolves to the canonical connection
  before any check, and the confirmation binds the canonical id.
  - Authority (design 6.3) is decided in SQL by
    `subscription_codex_reset_authority`: the authenticated RLS subject must
    be an organization administrator or an administrator of the workspace
    that manages the shared Codex connection, and only with the cutover
    enabled. The routine share-locks the connection through the
    connection's own UPDATE policies (which admit exactly those
    principals), so disconnect and credential replacement wait for the
    ledger step. The claim, adopt and send-fence ledger functions take this
    reader in place of the legacy `connected_by_subject_id` rule (an
    injected authority; legacy callers pass nothing and are unchanged);
    release and abandon touch only the attempt and are shared.
  - Only a same-origin managed browser human may prepare or redeem: bearer,
    MCP/service and scheduled callers are refused by the existing guard,
    and an agent acting as a person, which the legacy route accepts, is
    refused on the core.
  - Decision: redemption is served only for a connection managed by the
    requesting workspace. An organization-managed connection answers the
    legacy 409 ("managed in Organization settings"), because the ledger's
    per-credit fence is per workspace and an organization-level redemption
    route does not exist yet.
  - The bearer is read and refreshed through the 0671 connection seam under
    `subscription-refresh:<id>`. Preflight, the DB-time send fence, the one
    upstream idempotency key and claim release on an uncertain outcome are
    the legacy sequence: an uncertain send is retried only with the same key.
  - Completion (`completeSubscriptionCoreCodexResetRedemption`) records the
    outcome and audit event and, for `reset` or `alreadyRedeemed`, clears
    the stored exhaustion only when it was observed with the connection's
    current refresh generation, then delivers a core wake after commit. The
    legacy exhaustion columns and capacity outbox are never touched.
- **Overview (EP-N21).** The core overview projects the workspace's core
  pool. Each account's live usage (through the seam, as above) and reset
  details (the seam bearer plus the provider inventory) settle
  independently through a limiter of four provider calls, under the legacy
  route deadline with a fallback from persisted core quota. Redemption flags
  and recoveries come from the same SQL authority, for a same-origin browser
  human only; any other caller sees `managed_human_unavailable` and no
  redemption actions.

Review fixes (round 1):

- **Image operations are tied to the live turn attempt.** Both layers check
  it. The worker calls the chat lease's dispatch fence
  (`assertCurrentForDispatch`) before taking the image lease and again before
  the provider call. In SQL, the operation-lease guard (at creation) and the
  connection target (on every read, refresh and renewal) require the turn to
  be `running` on exactly the lease's attempt and execution generation, with
  a live chat-turn lease on the same connection. A cancelled turn, a
  superseded generation or an attempt that was never active can neither
  lease, read nor renew.
- **No reliance on the routine owner's row-level security.** The target
  routine's turn-bound branch checks visibility explicitly through
  `subscription_connection_visible`. A personal connection additionally
  needs the in-transaction `personal_access` capability for this exact turn
  and personal connections allowed now, and an ownerless turn is limited to
  shared organization- or workspace-scoped capacity. Leased sessions must be
  visible. Renewal re-runs the full target check before extending a lease,
  because a renewal touches only the expiry and the guard does not rerun.
  The reset-authority routine and the refresh persist/fail routines already
  decide explicitly. The suite runs the personal and revocation cases under
  both the shared superuser-owned template and a `NOBYPASSRLS` migration
  owner.
- **Owner-only target helper.** `subscription_codex_connection_target` is
  revoked from the application role in 0671 and again after role
  provisioning's schema-wide grant, and the runtime posture check rejects an
  executable helper.
- **Image pre-dispatch failures.** Any failure before dispatch (a thrown or
  refused lease acquisition, a lost chat lease, a failed renewal) is a
  verified pre-dispatch rejection: the ledger row returns to `prepared` and
  is never marked outcome-unknown. The holder id is a fixed-length hash of
  the attempt and tool-call id.
- **Attribution survives a deleted connection.** A foreign-key violation on
  `connection_id` (the connection deleted mid-turn) retries the fact without
  the attribution instead of dropping it.
- **Realtime requires its account.** The broker takes the account
  explicitly, so a disabled cutover always fails closed.
- **Wake hints never fail a committed read.** Usage routes catch a failed
  core wake delivery, as the overview does.
- **Unreadable connections report no data.** A connection the caller's
  workspace context may not read (personal or people-scoped) yields usage
  `status: "no-data"` and reset details reported as unsupported, not an
  error, keeping the response shape.

Left to PR 3:

- **Connect start/poll and disconnect (one or all).** Their core writers must
  respect the redemption share lock (a disconnect waits on it) and, for a
  credential replacement, take the `subscription-refresh:<id>` key.
- **Organization-level reset redemption** for organization-managed
  connections (see the decision above).
- **One ledger across the legacy and core paths for reset redemption.** The
  advisory locks and the per-credit lookup key on the credential id. While a
  legacy id and its canonical core id differ (an alias), a legacy attempt and
  a core attempt for the same credit do not see each other. The drained
  migration must resolve ledger rows through aliases, or key the fence on
  the provider account, so a credit can never be redeemed twice across the
  cutover.
- **Facts repair.** The Insights repair that recreates a missing model-call
  fact from its usage event does not know the connection; a repaired fact
  has a NULL `connection_id`.

##### PR 3b: the remaining Codex writers (dormant)

Migration 0688 (rolling, after 0679 extra-credit consent) and the matching code complete every Codex writer on
the core before the drained cutover, so the cutover moves data and flips no
route to a 409. Like PR 1/2 everything is dormant: no cutover row keeps the
legacy path unchanged, a disabled row fails closed (typed 503), and every
database routine below rechecks the enabled row itself.

The four owner-only writer implementations live in `opengeni_subscription_internal`,
not the previous binary's `opengeni_private` runtime capability inventory. The app
has neither schema USAGE/CREATE nor function EXECUTE there. Callers use the existing
restricted public seam. This preserves previous-binary readiness during rolling
0688 without granting capability mint/drop functions to runtime roles; current
readiness separately verifies the owner-only schema functions. The drained cutover
is still a later maintenance release, not activated by these writers.

Reconnect requires a verified upstream account **and person**. Distinct people
within a Team account remain separate, including personal connections. Missing
or `legacy:<id>` identities refuse `identity_unverified` rather than matching NULL,
guessing, or creating an ambiguous duplicate. Owner-only `resolve` is read-only:
failed in-use disconnects cannot mutate primary choice or settings versions.
The exported enqueue helper freezes acceptance v2 (service work gets empty authority),
so otherwise identical frozen-authority system updates can batch without weakening
the equality key.

Consent integration incident (2026-10-09): main added account-owned extra-credit
consent while this stack was under review. The shared-only compatibility setter
and omitted personal projection fields would have prevented a migrated personal
owner from revoking opt-in. The approved bounded integration repair uses the
existing owner-only `manage_subscription_codex_personal` seam, canonical/alias
resolution, row lock and separate consent OCC version. Same-state calls remain
idempotent; conflicting stale requests do not write. Only actual changes emit
the existing audit and capacity wake. Personal read projection includes typed
consent fields, and pause/reconnect/refresh never reset consent. Neither an
organization administrator nor service caller acquires someone else's personal
management capability. Placement reads live consent before allocating new work.

- **Connect and disconnect (SUB-OWN-01/04/08).** The device-code start
  touches no account state; workspace device state binds the starting actor
  and poll rejects another actor. Managed-cookie start/poll require the same
  browser origin. Both poll routes re-read the gate after token exchange,
  before writing. Poll writes through `connectSubscriptionCoreCodexConnection`:
  - a new shared connection is an organization decision: only an
    organization administrator creates one. From the organization route it
    is organization-scoped and organization-managed; from a shared
    workspace's route it serves and is managed by that workspace (exactly
    the core shape the drained cutover gives a legacy workspace account),
    with its assignment and pool policy;
  - the same upstream account reconnects in place: a new credential, the next
    refresh generation, active status. An organization administrator may
    reconnect any shared connection through the organization route, a workspace administrator only one their
    workspace manages (the core update policy); an account connected and
    managed elsewhere is never widened or taken over (`managed_elsewhere`,
    409). SUB-OWN-08 holds by construction: one connection per organization,
    provider account, signed-in person and owner. The person
    (`provider_subject_id`, the id_token's ChatGPT user id) is part of the
    identity because every member of a ChatGPT Team/Business/Enterprise
    workspace shares the account id: another person's login of the same
    ChatGPT workspace is a new connection, never a replacement of someone
    else's credential. Even an organization administrator using a workspace
    route cannot reconnect a connection outside that workspace's pool.
    A migrated login without a verified upstream person is not guessed or
    duplicated: reconnect returns `identity_unverified` (409). An authorized
    administrator must disconnect that legacy login and then connect anew;
  - in the person's own Personal workspace, connect creates or reconnects
    their personal connection through the owner-scoped writer
    `connect_subscription_codex_personal`, only with personal connections
    allowed there (SUB-OWN-05). A new personal connection carries a
    `subscription_connection` resource authority with the owner's one current
    generation for active personal Codex connections (1 for the first). After
    disconnect-all, the next generation exceeds the retained resource-authority
    high-water mark, under the owner's authority lock: old frozen work cannot
    regain access to newly connected credentials.
  Every credential replacement takes the connection's refresh key
  (`subscription-refresh:<id>`) before its row lock, so it waits for an
  in-flight refresh and for a redemption's `FOR SHARE`.
- **Disconnect** (`disconnect_subscription_codex_connection`): only an
  organization administrator deletes a shared connection (a delegated
  manager reconnects, renames and toggles allocation but does not delete,
  SUB-OWN-04); a personal connection is deleted by its owner from their
  Personal workspace, which revokes its resource authority. Deletion takes
  the refresh key and the row lock (waiting for a redemption's share lock),
  and is refused while any workspace's redemption of the connection is
  `provider_started` (its one upstream key must stay retryable) or while a
  live chat or operation lease still names it. Under the refresh and row locks,
  the exact-connection owner capability deletes expired leases even in private
  or other workspaces; live leases remain `RESTRICT`. Disconnect-all removes every account
  the workspace manages (or the person's personal connections) atomically.
  An organization account named from a workspace route keeps the legacy 409.
- **Personal connections in their owner's views.** The owner-only reader
  `subscription_codex_personal_connections` returns the acting person's own
  personal Codex connections (no credential material) for a workspace they
  may use. Their Personal-workspace account list includes them (never an
  Apps designation target: designations are shared-only). Status, rename,
  primary selection and allocator updates use the same viewer; mutations
  require the active owner in their own Personal workspace. Migrated aliases
  resolve inside this owner-only routine, never by widening application RLS.
  A session
  running on one shows it as "Running on" to that owner only; everyone else
  still sees the id with no account.
- **Organization-level reset redemption.** `subscription_codex_reset_authority`
  also authorizes an organization administrator for an organization-managed
  shared connection (the workspace-managed rule is unchanged), so the
  existing prepare/redeem routes and the overview serve organization
  accounts to organization administrators; everyone else keeps the legacy
  409 and `managed_human_unavailable`. The per-credit fence spans
  workspaces: `subscription_codex_reset_credit_fence` serializes one credit
  of one connection (`subscription-reset-credit:<connection>:<credit>`), and
  another workspace's open or consumed attempt for it refuses a second
  logical redemption. The same person's own attempt filed in another
  workspace (including a ledger row the cutover keeps in its legacy
  workspace) is re-filed into the requesting workspace when its claim has
  lapsed, so prepare adopts it and the claim resumes on its one upstream
  idempotency key. Expired `processing` claims in another workspace are
  removed under the credit lock. A live claim or another person's
  `provider_started` attempt is never stolen or discarded.
- **v2 writers at acceptance (design 3.7, EP-T13..T15).** Values are copied,
  never recomputed from current membership; non-human acceptance freezes
  the empty value; nothing is written before the cutover:
  - scheduled tasks freeze their value once at creation
    (`subscription_codex_task_authority_v2`, the acceptance rule: a personal
    entry only for the exact requesting person in their own Personal
    workspace, or a reusable session's acceptance value). An agent-created
    task instead inherits the exact causal turn's v2 value, narrowed to the
    same owner's personal/private destination; it never mints current membership
    authority. Revision
    authorities derive theirs from the task by trigger (the empty value when
    anyone but the owner authorized the revision, including no human authorizer).
    A firing reads that canonical revision slot and copies it onto its first
    turn or scheduled occurrence, with a further authorizer check;
  - Agent Message, Agent Steer and agent-submitted prompts copy the receiving
    source's value (its execution-context turn, its latest accepted turn, or
    a child's spawning parent turn) only when that source's exact owner is
    the causal human, mirroring the v1 pools; otherwise the empty value;
  - child-result notices carry the spawning parent turn's value through the
    outbox (the claim routine's fixed columns predate the slot, so claimed
    rows read it after the claim); background results and wait timeouts carry
    their causal turn's value;
  - the internal turn that delivers updates copies the receiving context
    turn's value for informational input, otherwise the delivered update's.
    Updates frozen with different values never share one turn; an update
    that froze none follows the v1 compatibility rule. Once the cutover is
    active, a missing value is the empty value.
- **Upgrade digests.** Both scheduled-task digest functions exclude the new
  immutable authority slot, like the immutable owner slot. Excluding only NULL
  would protect the rolling migration but not a later rename after the drained
  backfill. Neither rename nor pause/resume changes the execution digest or
  authority revision. The other new carrier columns do not participate in
  whole-row execution digests; the cutover's additional staging column is temporary.
- **Connecting-person audit.** Only a verified managed-cookie human supplies
  `connected_by_subject_id`; a `user:`-shaped bearer or agent subject is not
  proof of a managed human. Local/service connections retain NULL.
- **Owner-only capability policies.** The writers run as their owner under
  FORCE RLS with two new transaction-scoped capabilities,
  `codex_connection_owner` (the acting person's own personal connections and
  one connection's ledger) and `codex_reset_credit_fence` (one connection's
  ledger across workspaces), each admitted only by owner-only policies that
  read the capability through SECURITY DEFINER helpers (policies are
  evaluated for every caller, and the application role has no access to the
  capability table). The writers' caller check, the capability grant and
  drop helpers and the revision trigger function are revoked from the
  runtime role after role provisioning's blanket grant and asserted by the
  posture check.
- **Placement classification.** A shared connection with no
  assignment-policy row in a workspace keeps its management classification
  (organization pool unless that workspace manages it), as the compatibility
  projection and operation candidates already read it; otherwise an
  organization-scope connection connected on the core would be hidden from
  chat.

Decisions: a workspace administrator who is not an organization
administrator can no longer connect a new shared account on the core (the
legacy route let them); they reconnect what their workspace manages and use
their personal connection. Disconnect does not wait for running turns: it
refuses with the legacy "active turns are using it" message.

Tests: `packages/db/test/subscription-core-codex-writers-postgres.test.ts`
(gate off/disabled/enabled, every principal for connect/reconnect/disconnect
through canonical and aliased ids, RLS isolation across organizations,
personal rules, the ledger and lease guards, organization redemption and the
cross-workspace fence, internals not executable; the writer and fences again
under a NOBYPASSRLS migration owner),
`packages/db/test/subscription-core-codex-v2-carriers-postgres.test.ts` and
`apps/api/test/codex-core-routes.test.ts`.
##### PR 3: the drained Codex cutover

PR 3 is the one-way step. Maintenance migration
`0689_subscription_core_codex_cutover.sql` moves every organization's Codex
state onto the core and enables the Codex cutover for every organization in
the same transaction. It is split around a codec stage
(`packages/db/src/codex-subscription-core-cutover.ts`, restricted by the
runner to 0689 like 0598's Claude stage): the SQL prelude checks the drain and
opens the owner window, the stage moves credentials, and the SQL that follows
moves everything that references them, validates parity and restores the
window. Plain SQL is refused before any change.

Steps, as implemented:

1. **Drain.** The complete old and new runtime-login list is required; any
   live session of a listed login aborts with `55000`. A per-organization,
   per-source inventory is taken inside the owner window before any mutation.
   Every source that counts zero is proven empty by an RLS-immune probe
   (`ADD CONSTRAINT ... CHECK (false) NOT VALID` then `VALIDATE`), so a FORCE-RLS
   blind spot cannot certify an empty move. Pre-existing core Codex rows are
   refused (the core was dormant; nothing may hide behind them). Live work in
   a session whose owner subject and owner membership disagree aborts
   (`session_owner_ambiguous`).
2. **Credentials.** Each legacy secret is decrypted through the environment
   codec, checked to be the `{access_token, refresh_token, id_token}` object,
   canonicalized to exactly those fields, re-encrypted and read back; the
   readability parity compares content-free digests. Duplicates group by
   organization, upstream account (the stored ChatGPT account id,
   cross-checked against the id_token; a row with neither is never merged),
   the signed-in person (the id_token's ChatGPT user id, else its OIDC
   subject) and owner (personal owner membership, or shared). Every member of
   a ChatGPT Team/Business/Enterprise workspace shares the account id, so the
   account id alone would merge different people's logins (and hand one
   person's token to the other's Apps designation). Decision: merge only rows
   that are provably the same person. Distinct people stay distinct
   connections, each with its own credential, assignments, designations and
   pins; the core identity (`provider_subject_id`, added by 0688, part of the
   unique key) records the person. A row whose person is unknown, or whose
   stored email contradicts another row of the same person, is kept as its own
   connection (`legacy:<id>` as its person key when it shares the upstream
   account with another row; dispositions
   `person_identity_unknown_kept_separate`,
   `person_identity_email_mismatch_kept_separate`): keeping both credentials
   is a legitimate state, so it is not an abort. The healthiest row
   (active, then error, then needs_relogin; then the freshest refresh; then
   deterministic order) is canonical and keeps its id; every other legacy id
   becomes an alias. Conflict classes abort before any write and carry no
   values: `provider_identity_mismatch`, `personal_workspace_owner_ambiguous`,
   `personal_owner_missing`, `fedramp_mismatch`, `unrepresentable_status`,
   `unrepresentable_scope`. After parity the legacy ciphertext is blanked:
   one secret copy.
3. **Health, quota, policy, scope.** One policy-union implementation merges both
   connection ceilings (personal and shared) and duplicate workspace/pool
   assignments: only enabled rows contribute model sets when any row is enabled;
   if all are disabled their model union remains disabled. The personal ceiling
   is the entire policy because personal connections have no assignment-policy
   narrowing. This also covers Personal-workspace duplicates with NULL stored
   account IDs and a Personal-workspace row merged with a verified user-authority
   row for the same decoded account/person. A disabled unrestricted row cannot
   widen an enabled limited row, while multiple enabled rows retain their full
   legitimate union. SQL parity independently reconstructs both connection
   ceilings (`connection_model_policies`) and local assignment unions. The final
   review found that the earlier assignment-only repair missed personal ceilings;
   this bounded correction preserves identities, credentials and aliases rather
   than rejecting representable groups. Extra-credit consent
   carries only when every merged row opted in, retaining the maximum version;
   conflicting consent fails closed to disabled with the content-free disposition
   `extra_credit_consent_conflict_disabled`. Single-row consent is preserved.
   Status maps 1:1; `refresh_generation` is
   the legacy `version` (so quota observations stay fenced to the same token
   family); usage windows become the shared quota model, an exhaustion keeps
   its kind, a live plan-entitlement exclusion becomes a model cooldown until
   its 24-hour expiry, and an account never observed keeps a NULL observed
   generation (unknown, never exhausted). FedRAMP, reset-credit counts, plan
   history and scopes move to adapter-owned `provider_state`. A Personal-
   workspace account becomes its owner's personal connection with a new
   `subscription_connection` resource authority (generation 1, or the
   transferred generation of a legacy `user` row whose authority is verified
   and active; otherwise the authority is created revoked). A live turn's
   legacy `user` snapshot maps to personal v2 authority only when the
   canonical row of its connection is that verified user row (its generation
   transferred); a connection whose canonical row is a Personal-workspace row
   starts at generation 1 and no `user` snapshot names it, so an old revoked
   authority's generation can never coincide with a new one.
   Decision on scope (fail closed): a shared connection is `organization`
   scope only when its organization source has no allowlist, admits Personal
   workspaces and carries the widest allocator/model policy of its group, so
   every current and future workspace sees exactly that policy. Otherwise
   every workspace the legacy rows admit today is enumerated as a `workspaces`
   scope, and the organization source's reach over workspaces created later
   is kept by `opengeni_private.subscription_codex_auto_assignments`
   (provider-keyed as `opengeni_private.subscription_core_auto_assignments`
   since §5.3 PR 0c)
   (disposition `organization_reach_auto_assigned`): a NULL legacy allowlist
   assigns every new shared workspace, `allow_personal_workspaces` every new
   Personal workspace, each with the organization source's own allocator and
   model policy, exactly as legacy evaluated it at read time. Owner-only
   triggers on `workspaces` (insert) and `organization_memberships` (a
   Personal workspace assigned) apply it; a workspace first assigned as shared
   that becomes a Personal workspace follows the Personal rule. The core
   visibility function does not read `allow_personal_workspaces`, and changing
   it would touch every row-security policy, so this small fail-closed
   representation was preferred: without a row nothing is ever added, and the
   connection keeps the legacy `allow_personal_workspaces` value. Two source
   rows of one connection in one pool of one workspace (the same person
   signed in twice) merge into one assignment policy that keeps the wider
   of the two (`duplicate_pool_policy_merged`) instead of colliding. Every
   source row writes
   its exact `(connection, workspace, pool)` assignment policy (allocator,
   allowlist, manager); the connection-level values are the group's union.
   Placement now treats a shared connection with no assignment row in the
   workspace by its management classification (organization pool unless that
   workspace manages it), as the compatibility projection and operation
   candidates already did; PR 1 excluded it, which would have hidden every
   organization-scope account from chat in workspaces without a local copy.
4. **Settings.** Every organization gets an organization settings row: its
   rotation is the organization rotation row (on is `spread`, off is
   `primary_first` with the active account as primary; no row is `spread`).
   Workspace overrides: `workspace`, `organization` and `disabled` become the
   Codex provider override (`inferenceSource` or `enabled = false`);
   `automatic` gets no source override. The workspace rotation is mapped only
   where the workspace pool is in effect (explicit `workspace`, or
   `automatic` with local accounts), so a local primary keeps taking new work.
   A Personal workspace whose account became personal gets
   `personal_fallback_allowed = true` (unless an organization lock says no,
   recorded) and its owner opts in to personal fallback; its rotation row has
   no equivalent and is dropped (recorded).
5. **Bindings.** A manual pin is `explicit` (`explicit_choice`), otherwise the
   last (or policy) account is `automatic`, resolved through the alias map; the
   model is the latest Codex turn's product model; `last_model_call_at` is the
   session's latest model-call fact or unknown. An explicit pin to an
   unhealthy or newly ineligible account survives and waits (D-24): the
   binding/lease row guards are disabled only inside the migration
   transaction (the owner-only, non-dispatching backfill seam; the
   application role cannot alter triggers). Ownerless sessions and a personal
   target that is not the session owner's own private or Personal-workspace
   work get no binding (recorded).
6. **Leases, waiters, authority.** Live leases keep turn, holder, generation
   and expiry on the canonical connection; the moved legacy rows are deleted
   and expired ones dropped (recorded). Each waiting legacy waiter moves with
   its UUID as `waiter_id`, generation, both wake revisions, next check, reset
   kind and time, retry count, blocked-turn generation, goal fence, last wake
   reason and accepted-update link; the legacy row is superseded so no
   fallback lookup can revive it. Accepted authority v2 (Codex entry only;
   Claude and SuperGrok v1 bytes unchanged) is written on every live turn,
   live scheduled task and its current authority revision, and pending
   internal updates and outbox rows (new nullable, owner-immutable columns on
   those carriers). A personal entry is written only for exact owner-caused
   work: the stored human is the session owner, the owner membership is
   active, and the work runs in the owner's private session or Personal
   workspace; a v1 `user` snapshot keeps its generation only if a canonical
   personal connection carries that active generation, and a
   Personal-workspace account lends its one current generation. Updates and
   outbox rows carry no stored human, so they freeze the empty value. Nothing
   is minted from current membership alone.
   Apps designations of shared connections move with their version; one that
   points at an account that became personal cannot be represented
   (designations are shared-only) and is recorded.
   The single-use reset-credit ledger follows the canonical connection: every
   `codex_reset_redemption_attempts` row filed under a legacy id that became
   an alias is re-keyed to the canonical id, keeping its attempt id, upstream
   idempotency key, status, outcome, claim and retry state. The core claim
   keys its per-credit advisory lock, per-credit fence and ambiguous-outcome
   recovery by (workspace, connection id, credit), so without this a legacy
   `provider_started` attempt would be invisible to a core claim and the same
   credit could be consumed twice. Two credit-holding attempts (open, or a
   consumed outcome) that would meet on one (workspace, connection, credit)
   abort the cutover; attempts of credentials disconnected earlier keep their
   id and are recorded.
7. **Parity.** Per organization: credentials, connections, aliases, unique
   identities, workspace-pool policies, organization-pool admissions (every
   workspace each organization row admits today keeps its exact policy),
   personal connections with their authority, source modes, organization and
   workspace rotation, session pointers and bindings, Apps designations,
   leases, waiter ids/generations/revisions, live-turn v2 coverage and
   reset-credit attempts (all, and open ones) on canonical ids; plus
   enabled cutover rows for every organization and secret readability. Any
   mismatch rolls everything back. The counts and dispositions (no values)
   stay in `opengeni_private.subscription_codex_cutover_report`.
8. **Window.** All 35 relations are locked, their user triggers disabled and
   FORCE lifted by literal statements; both are restored from the captured
   state before commit, deferred keys are validated first, and the 0667 v2
   check is validated. The release-schema contract registers 0689 as
   maintenance at its three sites.

Activation decision. The migration writes **enabled** Codex cutover rows for
every organization. "No row" means the legacy path (PR 1/2), and after the
data move a legacy read would see blanked, stale tables, so leaving an
operator switch with no rows (or disabled rows) would either reach legacy state
or fail every preserved queued turn until an operator acted. The step-8
sequence also says the drained migration "backfills v2 authority and activates
the Codex cutover together". Organizations created later are seeded enabled by
an owner trigger on `managed_accounts`, and the application role can no longer
delete a Codex row, so "no row" is unreachable in a migrated database; the
switch remains a containment control whose off state is the existing
fail-closed maintenance behaviour. Runtime readiness requires the 0689
receipt, so a binary of this release cannot start against an unmigrated
database.

No dual write. After 0689 every Codex reader and writer the earlier PRs moved
targets the core. Also in this PR: plan-change history is recorded on the
core (a trigger keeps the previous plan and time in `provider_state` whenever
a writer changes a Codex connection's plan) and projected with the
plan-entitlement cooldowns into the legacy account shape; the Insights facts
repair attributes a rebuilt Codex fact to the canonical connection the same
attempt recorded in `codex.credential.selected` (through aliases; a personal
connection the workspace cannot see stays NULL); and a child agent's first
turn copies its causal parent turn's frozen v2 value.

The writers this cutover needs already exist, dormant, from PR 3b (migration
0688, which lands first): connect start/poll and disconnect on the core with
the redemption share lock and the `subscription-refresh:<id>` key,
organization-level reset redemption fenced per (connection, credit) across
workspaces (it re-files the person's own lapsed attempt that 0689 keeps in its
legacy workspace, and refuses another workspace's open or consumed attempt),
personal connections in the owner's views, and the v2 writers at acceptance
for scheduled tasks and firings, internal updates and child-result notices,
agent messages and Steer. 0689 backfills the v2 slots 0688 added for work
accepted before it; enabling the cutover switches those writers on.

Assignment-change wakes need no writer yet: no route edits workspace
assignments (the M5 scope editor must call the core wake).

Workflow compatibility. Activity and signal names and payloads are unchanged.
`test/integration/subscription-core-codex-cutover.integration.ts` arms a wait
through the legacy path, records the legacy peek's result, runs 0689, then
executes the recorded arguments: the core waiter has the same id, generation
and revision, keeps waiting while exhausted and resumes the same turn after a
core wake. The pinned legacy capacity-wait history replays against the current
bundle there and in the PR 2a suite.

Legacy readers after the cutover (review finding, fixed here). Every reader
that is reachable after 0689 now follows the Codex cutover disposition the
same way (no row: legacy unchanged; disabled: not ready, no legacy read;
enabled: core): the model catalog and its readiness, the default session
model (session create, drafts, scheduled occurrences, `list_models`),
`workspaceCodexSubscriptionActive`, `isCodexBilledTurn` and admission, the
connection model restrictions, the claim overlay, the Codex connection-access
route (core read; saving answers 409 until the M5 scope editor adds a core
writer), the session `codexCurrentSelection`, and the goal, claim-failure,
Variable Set and claim readers of a parked turn's waiter (they also read the
core waiter, so a turn parked on a core waiter is not claimable). Catalog
readiness uses chat placement's shared pools (automatic admits both local and
organization candidates), without changing PR 2c Live/transcription's single-source
policy, and the caller's own personal connections only in their own
Personal workspace with personal connections allowed,
read through the owner-only reader; a subjectless reader sees shared
connections only. Live model lists come from the 0671 connection seam, cached
per refresh generation; a personal connection's list cannot be read outside
an accepted turn, so its models are selectable with unknown status unless a
refusal cooldown applies. Ordinary use in the owner’s Personal workspace does
not require fallback consent; outside that workspace, private-session fallback
still requires both the organization setting and the owner’s opt-in. The full reader/writer inventory, with each call site
gated, unreachable or intentional, is in the PR 3 description.

Personal funding in an owner-private shared-workspace session is intentionally
not a generic workspace catalog fact. `isCodexBilledTurn` accepts an exact durable
turn reference, re-reads its frozen v2 and uses the accepted placement world,
including owner/human/generation and fallback checks. Service, nonowner and empty
authority cannot borrow a live personal connection. Temporary capacity waits do
not turn subscription-funded work into deployment-funded work. Codex initial
turn and prompt credit admission run after authority freeze, before transaction
commit; rejected prompts roll back, while initial-turn initialization retains
the existing session-shell/retry lifecycle. No admission read mints authority.

Review hardening (recorded with the decisions above): the live-lease parity
compares turn, holder, generation, expiry and canonical connection against a
snapshot taken before the move, and no legacy lease row is left behind
(expired ones are a recorded disposition); a Codex cutover row keeps its
organization and provider (a trigger refuses moving it to another provider,
which would have made it deletable); every failure of the migration leaves as
a content-free error (fixed refusal text, or the SQLSTATE and constraint
name), never a driver error carrying statement parameters; and the Insights
repair lookup filters by turn so the workspace/turn/type index serves it.

Left to PR 4 (unreachable after 0689, safe to delete): the legacy Codex
selector (`apps/worker/src/activities/codex-rotation.ts`, the Codex-only
capacity, settlement and recovery branches, the fleet shadow), the legacy
arms of `peekSessionWork`/`getCodexCapacityWait`/`reconcileCodexCapacityWait`
and the legacy table fallback, the legacy Codex accessors in
`packages/db/src/index.ts` (credentials, rotation, sources, pins, usage,
leases, Apps settings, redemption authority by connector), every `legacy`
branch behind `readCodexCutoverDisposition`/`codexRouteDisposition`, the
"no row" disposition itself, the M1 Codex shadow world, and the tests that
recreate the pre-cutover world to exercise them. The legacy tables stay
read-only for forensics until M6.

#### PR 4: runtime-only legacy Codex deletion

The PR 3 description above is the point-in-time rollout record. PR 4 removes
its no-row compatibility path: missing and disabled Codex cutover rows now fail
closed, while generic Claude/SuperGrok gating is unchanged. Legacy Codex
selector/rotation, fleet-shadow production, lease heartbeat/release fallback,
settlement/plan recheck, catalog/media/Apps routing and database accessor
families are removed. Core orchestration, credential refresh, credit consent,
quota attribution, binding clock, recovery and exact waiter/goal/claim fences
remain. Session current-selection projection reads only the core.

Public paths, payloads, types and canonical/legacy aliases remain. The generic
token resolver still supports the core organization-administration usage reader:
admin-scoped alias resolution freezes a canonical id before its refresh lock
and generation CAS; no routing or consent changes accompany that read. The
reset-redemption ledger is intentionally live, with explicit core authority
required by claim/adopt/send helpers, not a legacy routing store. Core operation
leases and accepted funding remain, as does connection-policy PUT 409 until M5.
Personal-fallback catalog precision and the scope editor are not expanded.

`check:no-legacy-codex-runtime` is also run by `check:subscription-contract`.
It rejects executable legacy table/schema references and imports of historical
Codex fixtures. Exceptions are exact declarations: retained schema/FKs,
declarative deployed-schema posture inventories, and the codec stage of 0689.
Historical SQL is untouched. Test-only snapshots retain old schema regressions
and the real pre-cutover peek; they are not reachable by production code.

Temporal activity names `getCodexCapacityWait`/`reconcileCodexCapacityWait`, the
`codexCapacityChanged` signal, workflow patch markers and omitted-provider
meaning Codex remain unchanged. Missing migrated core waiters return the
established stale result. Validation includes both live Temporal wait scenarios
and pinned historical replay, plus the actual old peek followed by migration
and current reconciliation of the same waiter id/generation/revision.

This source merge is not deployment activation. The PR 4 binary may start only
after drained codec-aware 0689 receipt/readiness; no old binary restart or
legacy fallback is possible after scrub. Table/column removal is still M6.

#### Verification plan

- Run `bun install` first. Test Codex adapter conformance without network using
  scripted local upstreams for token materialization/refresh, usage/quota,
  streams, refusals, malformed responses, delays, connection loss, partial
  streams and entitlement failures. A network-denial guard must fail any
  unexpected socket access.
- Compare production placement to the independent reference model on generated
  worlds and Codex scenarios: explicit account context, source modes,
  organization-first eligibility, model restrictions, unknown/reset quota,
  cache warmth, failover bounds, explicit pins and remote-v2 lock/portable
  conversion.
- Test migration parity on real PostgreSQL with the restricted runtime role
  and a separate owner-migrated harness. Seed duplicate identities, encrypted
  secrets, aliases, all legacy modes/scopes, workspace policies, pins, leases,
  waiting generations/revisions, reset-credit state, and personal/shared
  accepted work. Assert exact source/target counts and explicit
  account-context authorization, FORCE-RLS visibility and rollback on
  ambiguous ownership or parity failure. Every ledger-replaying test declares
  a 180 000 ms budget.
- Stress simultaneous placement and serialized refresh for one canonical
  connection through canonical and aliased ids. Assert no oversubscription,
  duplicate refresh, stale-generation quarantine, duplicate redemption or
  double image charge. Cover concurrent pin/mode changes and wake-revision
  races; prove Claude/SuperGrok legacy rows remain untouched.
- Verify operation lease concurrency independently of turn leases: overlapping
  image operations, realtime with no turn, sessionless transcription, lease
  expiry/reclaim and crash-before/after dispatch. A stale generation must not
  release or authorize another operation; sessionless operations must not gain
  personal-account access without the exact supported owner/workspace context.
- Inject crashes before/after migration commit, after lease transfer, after
  waiter wake commit but before signal, and during API refresh/redemption.
  Verify restart/reconciliation is idempotent and never repeats an uncertain
  upstream mutation.
- Replay `legacy-session-capacity-wait-history.json`, plus signal-before-peek,
  peek-before-signal, continue-as-new, wake-outbox retry and alias-remapped
  waiter histories. Assert workflow activity and signal names/shapes remain
  compatible.
- Run RLS/authz tests as a restricted role across shared, private and Personal
  sessions, no-initiating-human/service work, delegated management, aliases,
  and organization boundaries. Add mutation checks for selection, secret
  loading, source mapping, waiter generations and verification claims. Mark a
  contract requirement verified only when a product-path test names and
  exercises it.
- Verify a deduplicated upstream identity with conflicting per-workspace model
  allowlists, allocator states and managers preserves the exact eligible
  model/account set and administration boundary. Verify Apps remains usable
  for a previously designated local connection while inference source is
  `organization`, and that switching back to `workspace`/`automatic` restores
  the same local candidate pool. Verify transcription provider ordering is
  initial selection only and that a selected subscription failure does not
  retry the same audio through another provider, for both one-shot and
  resumable recordings.
- Run repository static guards, focused package/API/worker tests, full CI and
  migration guards. For PostgreSQL tests use the documented disposable
  pgvector service at `127.0.0.1:61440` with real-DB flags; if absent, use the
  throwaway PostgreSQL 17 cluster procedure. Never use real Codex credentials
  or live upstream endpoints.

### 5.1.2 M4: one runtime, per-provider adapters

Decision (unify first). Every source of model access (Codex, Claude and
SuperGrok subscriptions now, API-key connectors such as OpenRouter and Vercel
later) runs through one provider-neutral runtime: the same placement, leases,
reservation and settlement, credential load and refresh orchestration, health,
writers, settings projections, waiters and catalog cache. A provider differs
only in a small adapter (§2.1): sign-in and credential format, refresh, usage
or quota decoding, error classification, model catalog and capability flags.
M3 shipped that runtime under Codex names; M4 first extracts it, so Claude and
SuperGrok are added as adapters rather than copies. Copying the Codex modules
per provider would multiply the authorization, fencing and lock-order surface
that the M3 reviews verified once, and every later fix would need to land N
times.

The shared SQL is provider-neutral by construction: the provider is an
argument, and any provider difference comes from data, never from a branch on
a provider name.

- `opengeni_private.subscription_core_providers` (migration 0707) lists the
  providers whose runtime runs on the core, with the per-provider data the
  shared routines need: `extra_credits` (whether `manage ... 'extra_credits'`
  is meaningful) and `primary_setting_column` (which `subscription_settings`
  column holds the provider's primary connection until settings are keyed by
  provider). It is owner-only data; a provider without a row is refused by
  every neutral routine, even when its cutover row is enabled (fail closed).
  Codex is seeded. A provider joins the core by a migration that inserts its
  row and, where needed, widens the provider lists in existing CHECK
  constraints; the neutral routines need no change for another subscription
  provider, while the deferred routines listed below still carry
  per-provider branches that its step must extend. The neutral routines, like
  their Codex twins, accept only `kind = 'subscription'` connections; an
  API-key connector's step widens that filter from data (a registry column
  naming the connection kind), never by a provider branch. A provider's
  registry row must land with or after its drained
  cutover: the row alone turns on the shared disconnect-admission trigger for
  that provider's lease and binding rows, whatever its cutover row says.
  `primary_setting_column` must be NULL (a provider without a primary
  setting, such as an API-key connector) or exactly
  `<provider>_primary_connection_id`, so no provider can be pointed at another
  provider's column.
  The registry is append-only (a trigger refuses DELETE, TRUNCATE and a
  changed key): removing or renaming a row would make the shared
  disconnect-admission trigger skip that provider's rows while older binaries
  still call its provider-named routines. The same trigger checks on every
  registry write that `primary_setting_column` is a real uuid column of
  `subscription_settings`; a migration that drops or renames such a column
  must update the registry first (the `manage ... 'primary'` write fails with
  an error, not a wrong write, if it does not).
- Neutral capability kinds `refresh_authorized`, `refresh_write`,
  `connection_refresh_authorized` and `connection_owner` carry their provider
  (required and format-checked like a registry key) and mirror the `codex_*`
  kinds one for one, with owner-only policies. On rows that carry a provider
  (connections, aliases, leases) a capability admits only rows of its own
  provider.
  Memberships, resource authorities, settings and Apps designations carry no
  provider; their policies admit the owner's own rows for any provider's
  owner capability, pinned to the capability's account and, per table, to the
  owner's subject (memberships, authority insert and read), the exact
  connection (authority revoke, Apps designations) or the current workspace
  (settings), exactly as the Codex-named policies do. The capability key
  omits the provider, so the owner-capability grant refuses a second
  provider's grant on an already held key instead of
  sharing the first provider's row.
- Neutral routines (provider first) replace the Codex-named routines the
  generic runtime calls, with identical authorization, lock keys and order,
  fences, RLS posture and grants: the turn refresh seam
  (`begin_/persist_/fail_subscription_core_refresh`,
  `persist_subscription_core_refresh_with_plan`,
  `subscription_core_refresh_write_allowed`), connection health
  (`quarantine_subscription_core_connection`,
  `recover_subscription_core_connection_health`), v2 accepted authority
  (`subscription_core_acceptance_authority_v2`,
  `subscription_core_task_authority_v2`,
  `subscription_core_revision_authority_v2`), the connection credential seam
  (`read_subscription_core_connection_credential`,
  `begin_/persist_/fail_subscription_core_connection_refresh`, owner-only
  `subscription_core_connection_target`), the personal writers
  (`connect_subscription_core_personal`,
  `disconnect_subscription_core_connection`,
  `manage_subscription_core_personal`,
  `subscription_core_personal_connections`) and their internals
  (`subscription_core_owner_capability_held`,
  `subscription_core_owner_membership_held`, owner-only
  `subscription_core_writer_context`,
  `grant_subscription_core_owner_capability`,
  `drop_subscription_core_owner_capabilities`). Both families take the same
  per-connection refresh key and the same connect and personal-authority
  keys, so an old binary on the Codex-named routines and a new binary on the
  neutral ones serialize exactly as two old binaries do. Default relogin and
  refusal texts are provider-free; the runtime passes the provider's own text,
  so stored Codex values are unchanged. Neutral routines never decode a
  provider fact: `read_subscription_core_connection_credential` returns the
  opaque `provider_state` (the Codex-named routine returned a decoded
  `is_fedramp`), and the Codex adapter reads its FedRAMP flag from it, as the
  chat-turn credential load already did. The shared disconnect-admission trigger
  admits by registry membership instead of a provider literal.
  Its "prior request outcome is unresolved" refusal text loses the provider
  name (no caller matches the text).
- Defect fixed in earlier merged work (migration 0691): the two `SECURITY
  DEFINER` subscription guard triggers (`guard_subscription_disconnect_admission`
  and `guard_subscription_designation_disconnect`) captured the migration
  session's search path, without `pg_temp`, so a session's temporary table
  could shadow the connection, turn or lease rows they check. 0707 sets their
  search path to the data schema with `pg_temp` last.
- Rolling compatibility and retirement. The Codex-named routines, kinds and
  policies stay unchanged for binaries that still call them (staging runs
  them since 0689/0700). They are dropped by the final M4 retirement step, or
  M6 if that step is merged first, in a migration that runs only once no
  binary older than 0707 can start (a readiness check on the neutral routines
  already prevents an older database from serving a newer binary).
- Genuinely Codex-only, and staying so: the Codex Apps routines and the
  reset-credit authority and fence.
- Left Codex-named by this extraction and made provider-keyed by §5.3's
  generic precursor (PR 0), before the first SuperGrok cutover: the cutover
  planner rules (`codex-subscription-core-cutover.ts`) and the 0689 cutover
  machinery, the auto-assignment table
  `opengeni_private.subscription_codex_auto_assignments` with its apply
  routine and triggers, `record_subscription_codex_plan_change` and the
  plan-change trigger, organization reach (`subscription_codex_reach`,
  `set_subscription_codex_reach`; the shared TypeScript writers reach it only
  through the Codex binding's allocator hook),
  `list_organization_codex_workspace_ids`, the scope visibility and wake
  routines, and 0691's operation-kind CHECK, which admits `model` and
  `credential_request` only for Codex.
  §5.3 "PR 0c: provider-keyed cutover planner and organization reach"
  (migration 0713) made the planner rules, the auto-assignment table, its
  apply routine and triggers, plan-change history, organization reach, the
  workspace inventory and the capacity wake provider-keyed, and removed the
  allocator hook; the shared core's wake and organization paths use none of
  the Codex scope-visibility helpers.
- Deferred, with their provider branches recorded for the Claude and
  SuperGrok steps: `authorize_subscription_personal_access` (v1 branches per
  provider until each provider's drained cutover),
  `subscription_effective_settings` (per-provider settings columns) and
  `guard_subscription_designation_disconnect` (Apps designation).

Fail-closed choices recorded for review: an unregistered provider is refused
by every neutral routine even with an enabled cutover row; the neutral
owner-capability drop removes only the neutral owner capability of the same
provider, never the reset-credit fence; `manage ... 'primary'` is refused when
the registry has no primary column, and `'extra_credits'` when the provider
has no extra credits.

Settings. Per-provider settings columns (`codex_primary_connection_id` and
the `rotation`/`providers` JSON keys) stay as they are in M4. Older binaries
still write the Codex column, and `subscription_effective_settings` projects
it; moving to a provider-keyed shape while those binaries run would need a
dual-write trigger over the same rows the 0689 cutover froze. The registry's
`primary_setting_column` isolates the per-provider column for the shared
writers, so the keyed shape (one row per provider with the primary
connection, backfilled from the columns) is a drained step in M6, together
with dropping the columns.

### 5.1.3 M4: shared TypeScript core and the adapter interface

The TypeScript runtime follows the same rule as the SQL: one implementation,
the provider as data. Shared modules live in `packages/db/src/subscription-core/`
(plus three M3 modules kept at their paths and now parameterized by provider:
`subscription-core-placement-world.ts`, `subscription-core-repository.ts`,
`subscription-core-acceptance-authority.ts`). They take a
`SubscriptionCoreProvider` binding (`subscription-core/provider.ts`): the
provider's adapter, the SQL expression for its remote-compaction session lock
(or null), the error classes its callers expect and the settings column that
holds its primary connection. (An optional hook run when an organization
allocator switch changed, through which only Codex kept its organization
reach in step, was removed by §5.3 PR 0c: the shared core refreshes any
provider's reach through `set_subscription_core_reach`.) The primary column
is the `primary_setting_column` of
the provider's SQL registry row until settings are keyed by provider: always
`<provider>_primary_connection_id` (checked when the binding is used, as the
SQL CHECK does), or null for a provider without a primary setting, whose
rotation and source writes leave every primary column alone and whose primary
writes are refused. A test checks that the TypeScript bindings and the SQL
registry rows agree. A refused workspace source change carries a typed reason
(`personal_workspace` or `forbidden`) so routes never parse its message. Each shared runtime is a factory memoized
per binding (`subscriptionCoreTurns(provider)`,
`subscriptionCoreOperations(provider)`, `subscriptionCoreRequests(provider)`);
administration, connections and catalog are plain functions taking the
binding.

Adapter interface (`packages/subscriptions/src/adapter.ts`, pure types).
`SubscriptionCoreAdapter` is what the shared runtime reads, next to the
existing `ModelConnectionAdapter`/`SubscriptionProviderAdapter` (sign-in,
transport, entitled models, error classification, cache facts, history
compatibility, refresh and quota decoding, §2.1):

- `provider`, `displayName` (error texts only, never routing),
  `modelPolicyProviderId`;
- `capabilities` (`ProviderCapabilities`, now with `extraCredits`);
- `credentialKind`: `oauth`, `setup_token` or `api_key`;
- `quotaKind`: `usage_windows`, `spend_budget` or `rate_limits`;
- `cacheFacts` (exact TTL or a measured idle cut-off);
- `health`: forbidden-quarantine and entitlement-cooldown durations;
- `credential`: `decode`/`encode` of the decrypted plaintext (fixed error
  text, never echoing it) and `expiry` (the embedded expiry when the store has
  none);
- `refresh`: `CredentialRefresher` (`windowMs`, `fallbackMs`, `rotate`,
  `reloginMessage` classifying a permanent refusal) or `null` for credentials
  that never renew;
- `reloginText(message)`: the stored needs-relogin text.

`credentialKind`, `quotaKind` and `health.entitlementCooldownMs` are declared
facts the Codex runtime does not read yet; they are reserved for the steps
named below that wire API-key credentials, spend-budget quota and the shared
settlement. The core reads `capabilities.extraCredits`: the placement world
clears `extraCreditsEnabled` for a provider without it, so the pure policy
(`eligibility.ts`, `reference-model.ts`) no longer tests a provider id.

A credential that never renews (`refresh: null`) is refreshed by nobody. The
shared resolver's policy (`subscriptionCoreRefreshPolicy(adapter)`) is then
`null`: the credential is used until its known expiry, never refreshed early
or because its age is unknown. Once it has expired, or after a forced refresh
because the provider refused it, the shared refresh takes the same lock and
generation fence as a rotation and then marks the connection needs-relogin
through `fail_subscription_core_refresh` (or the connection-level twin) with
`adapter.reloginText("")`, so the turn fails with the provider's relogin
error instead of an access-lost error.

The core owns everything else: placement and re-placement, turn and
operation leases, request reservation and settlement, the credential load
with one per-connection lock and `refresh_generation` fencing (the adapter
only rotates), single-flight resolvers, health, quarantine, recovery and
model cooldowns, the model catalog cache, usage observation persistence,
waiter cleanup and v2 accepted authority.

How the next sources fit. The shared runtime above needs no change for them;
each step adds its adapter and binding plus the pieces listed after this list,
which are still Codex-named or missing today:

- SuperGrok: `oauth`, `usage_windows`; realtime client secrets,
  transcription, image and video funding are operations on the shared
  operation lease and request reservation (`capabilities.realtime`,
  `fundsMedia`); the exhausted-quota refresh and the status probe are
  operation fetches through the shared custody path.
- Claude: `setup_token` (`refresh: null`, `autoRenews: false`, so an expired
  token becomes needs-relogin instead of a refresh) or `oauth` with a
  refresher; `cacheFacts` carries the exact cache TTL; response-header usage
  observation and usage refresh feed the shared quota observation.
- API-key connectors (OpenRouter, Vercel): `api_key`, `refresh: null`,
  `quotaKind` `spend_budget` or `rate_limits`, `autoRenews: false`,
  `quotaWindows: false`; their models (possibly many vendors') come from the
  adapter's entitled-model catalog into the shared catalog cache. A refusal
  the adapter classifies as rate-limited cools the model or source down
  exactly as a subscription window does. A later step adds a fake API-key
  adapter conformance test.

Still Codex-named or missing, and owned by the provider steps (or by the
shared settlement step they share) rather than by this extraction:

- worker settlement (`apps/worker/src/activities/agent-turn/codex-core-settlement.ts`):
  refusal classification into quarantine, model cooldown and quota writes is
  Codex-specific code in the worker; it moves behind an adapter
  `classifyError` hook (unifying `SubscriptionCoreAdapter` with
  `SubscriptionProviderAdapter.classifyError`);
- capacity waits and wake delivery, the usage fetch, operation candidate
  ordering and the API routes, which call Codex-named wrappers over the
  shared core;
- quota decoding: a `decodeQuota`/usage-probe hook on the adapter and a
  spend-budget quota shape (`quotaKind` is only declared today);
- a `video` operation kind (the 0691 operation-kind CHECK and
  `SubscriptionOperationKind` list image, realtime and transcription);
- per-model cache facts and model-policy provider ids for an adapter that
  serves several vendors' models (`cacheFacts` and `modelPolicyProviderId`
  are per adapter today);
- connection administration for API-key connectors: the shared writers
  (administration, connect and disconnect) and the neutral SQL routines only
  manage `kind = 'subscription'` rows, and the shared connect requires an
  upstream account id and person id to tell logins apart, which an API key
  does not have. Placement and the serving catalog already read rows of
  both kinds, so the API-key step either widens the writers' kind filter
  with an identity rule for keys (for example a key fingerprint) or keeps
  API-key rows out of the core until it does.

Registry. `packages/db/src/subscription-core-providers.ts` is the only module,
besides adapters, that enumerates providers. Its bindings are a private frozen
map behind `subscriptionCoreProviderIds()`, `subscriptionCoreProvider(id)` and
`subscriptionCoreAdapter(id)`; the lookups throw for an unregistered id and
assert the binding's adapter carries the id it is registered under. The core
uses the registry at runtime: `memoByProvider` refuses to build a runtime for
a binding whose provider id is not registered (test bindings of a registered
provider, such as a non-renewing variant, still run), and the neutral entry
points that take a provider id (v2 authority, refresh persistence, waiter
cleanup) look it up first. Adding a provider is an adapter and binding module,
one registry entry and its SQL registry row (§5.1.2).

Guard. `bun run check:subscription-core-neutral` (chained into
`check:subscription-contract`, with a unit test) scans
`packages/db/src/subscription-core/`, `packages/subscriptions/src/` (the whole pure package) and the three
provider-parameterized M3 modules. It fails when a shared module names a
provider or vendor (code, SQL text or comments; the all-caps `XAI` vendor name
is matched case-sensitively) or branches on a provider: a comparison with a
literal on either side or with a named constant, a `switch` or `case` on a
provider, `[...].includes(provider)`, an object literal indexed by a provider,
`startsWith` on a provider id, and SQL `= any('{...}')`, `is distinct from`
or `provider_id` comparisons. It also fails when the TypeScript registry and
the SQL registry rows differ. It is line-based: a conditional split across
lines in an unusual shape can evade it, so review still checks for provider
logic in shared modules.

Module map (old Codex module, its new shared home, and what stays Codex):

| M3 module | Shared module | Kept in the Codex module |
| --- | --- | --- |
| `subscription-core-codex.ts` | `subscription-core/turns.ts`, `subscription-core/credential-resolver.ts` | credential mapping (ChatGPT account id, FedRAMP flag), the turn token resolver wrapper, every exported name |
| `subscription-core-codex-operations.ts` | `subscription-core/operations.ts` | connection token resolver, candidate ordering, plan voice entitlement, usage endpoint fetch and decoding |
| `subscription-core-codex-requests.ts` | `subscription-core/requests.ts` | Apps request reservation and settlement |
| `subscription-core-codex-waiter-cleanup.ts` | `subscription-core/waiters.ts` | the Codex-named wrapper |
| `subscription-core-codex-compat.ts` | `subscription-core/administration.ts` (cutover disposition, workspace and organization pools, personal rows, allocator, extra credits, rename, primary, rotation, workspace source) | the legacy Codex account projection (ChatGPT account id, reset credits, plan history, plan-entitlement exclusions), rotation shape, every exported name |
| `subscription-core-codex-connections.ts` | `subscription-core/connections.ts` (connect personal and shared, disconnect, disconnect all) | the FedRAMP flag as provider state, every exported name |
| `subscription-core-codex-catalog.ts` | `subscription-core/catalog.ts` (serving connections, model admission, readiness) | every exported name |
| `subscription-core-placement-world.ts`, `-repository.ts`, `-acceptance-authority.ts` | same paths, provider-parameterized | Codex-named wrappers in `subscription-core-codex-bindings.ts` |
| (new) | `subscription-core/provider.ts`, `subscription-core/errors.ts` | `subscription-core-codex-adapter.ts` (adapter and binding), `subscription-core-codex-errors.ts` (error classes) |

Every `@opengeni/db` export that existed before this step keeps its name,
signature and behaviour; callers outside `packages/db` are unchanged. The new
shared runtimes are internal to `packages/db` (the package index exports none
of the provider-parameterized entry points). Provider-derived texts keep
Codex's bytes: wake reasons are `core_<provider>_<event>`, the extra-credits
audit action `<provider>.extra_credits.updated`, the Apps-cleared audit action
`<provider>_apps.cleared_on_disconnect` (only for a provider with the `apps`
capability), the shared connect lock key
`subscription-connect:<account>:<provider>:shared:<upstream account>`, and
source-refusal texts use the adapter's display name. Extra credits are
writable only for a provider with the `extraCredits` capability.
Codex Apps (`subscription-core-codex-apps.ts`) and reset credits stay Codex
modules, and so does the operation candidate list in
`subscription-core-codex-operations.ts`. Organization reach is
provider-keyed since §5.3 PR 0c (`subscription_core_reach` /
`set_subscription_core_reach` over `subscription_core_auto_assignments`,
migration 0713), which the shared core calls with the binding's provider;
Codex's 0702 pair wraps it.
Codex Apps request reservation uses the shared
`reserveSubscriptionCoreDesignatedRequest` (source lock, then insert; holder
`<operationKind>-request:<uuid>`), taken under the Codex Apps settings lock.

### 5.2 Legacy shape mapping

| Legacy | New |
| --- | --- |
| Workspace-scoped credential in a shared workspace | Shared connection scoped to that workspace, managed by it. |
| Workspace-scoped credential in a Personal workspace | Personal connection owned by that workspace's owner. Set the owner's `personal_fallback_opt_in` and the effective workspace `personal_fallback_allowed` override (D-18); otherwise opt-in alone cannot reach the fallback candidate. An explicit organization lock of `false` remains authoritative and is recorded as a non-parity disposition, never overridden. |
| Organization credential with `allowed_workspace_ids` / `allow_personal_workspaces` | Shared connection: `organization` scope when the list is NULL, otherwise `workspaces` scope with the same list. |
| User-scoped credential (xAI, Claude) | Remains on its existing provider-specific v1 path through M3; M4 maps it to a personal connection for the same membership. Work accepted before that provider's cutover carries its authority in a compatibility record (§5.3 "Accepted authority across the cutover"), because v2 is immutable; work accepted after the cutover writes that provider's v2 entry. |
| Codex `automatic` | No override. Where the workspace has local accounts, the workspace's Codex rotation becomes `primary_first` with its active local account as primary, or `spread` if its rotation was on, so local accounts keep taking new work. |
| Codex `workspace` | Workspace override `inference_source = workspace` and compatibility projection `use_organization_accounts = false` for Codex. |
| Codex `organization` | Workspace override `inference_source = organization` and compatibility projection `use_organization_accounts = true`. The workspace's local Codex connections are excluded from inference by the source filter, but retain their workspace scope for independent consumers such as an existing Codex Apps designation and can be selected again if the source changes. Only organization-classified accounts serve inference, as today. |
| Codex `disabled` | Workspace override `enabled = false` for Codex; the legacy source endpoint continues to project `disabled`. |
| Rotation rows | Only the rows for the pool currently in effect are mapped (organization row to organization settings, workspace rows to workspace overrides). Rotation off maps to `primary_first` (D-13). Personal-pool rotation rows have no equivalent and are dropped (documented). |
| Codex session pin/last columns; xAI/Claude pin rows | One chat binding per session: a manual pin becomes `explicit`; otherwise the most recent pin or last account becomes `automatic` with `last_model_call_at` from the latest model call. Several per-pool rows collapse to the one for the session's current model provider. |
| Leases, waiters | Moved with generation and wake revision; several per-pool waiters on one session collapse to the waiting one for the blocked turn. Ownerless-session waits carry the exact session capability and remain shared-only during recovery. |
| Codex Apps designation | `subscription_apps_designations (workspace_id, connection_id, version)`; any in-scope connection may be designated (§6.3). |

When duplicate workspace copies of one upstream account collapse to one
connection, connection-level policy alone may not preserve each source row's
model allowlist, allocator eligibility, delegated manager, or legacy inference
pool. M3 therefore adds an assignment-policy relation keyed by `(account_id,
connection_id, workspace_id, inference_pool)` with those exact legacy
per-workspace values; `inference_pool` is `workspace` or `organization`. This
is a multi-membership relation: one deduplicated connection may belong to both
legacy pools in one workspace, with source-specific policies preserved
separately. SQL and TypeScript effective settings resolve the same
`inference_source`; `automatic` admits both authorized shared pools, while
explicit `workspace` and `organization` select only that classified pool.
Within automatic shared candidates, effective rotation/primary preference
orders new work, and a primary that cannot serve falls through to another
eligible shared connection before any opted-in personal fallback. Personal
connections never become automatic shared-pool members. Management
authorization applies the matching assignment policy before connection-wide
defaults. This preserves SUB-OWN-08 uniqueness without unioning model
permissions or discarding a workspace's management boundary. Source mode
controls inference selection, not connection visibility or non-inference
consumers.

### 5.3 M4 implementation plan

This addendum is the implementation boundary for M4: SuperGrok (provider id
`xai`), then Claude (`claude`), move onto the shared core as adapters, after
which synthetic pool subjects and per-provider SQL decision functions are
retired. It mirrors §5.1.1 and does not restate what the shared core already
does for Codex: placement, chat and operation leases, the per-connection
refresh lock and generation compare-and-swap, waiters and the wake outbox,
turn failures, bindings, assignment policy, aliases, effective settings and
the ownerless shared-only capability apply unchanged. Only provider-specific
facts, data moves and the decisions M3 did not need are written here. No web
UI redesign is in scope; any visible change stops for a product-owner preview
with real components.

#### Starting point and assumptions

Written against `77853d772`. M3 is merged (Codex on the core, 0688/0689/0700;
runtime-only legacy Codex deletion in M3 PR 4). Claude and SuperGrok still run
on the factory tables (`{xai,claude}_subscription_credentials`,
`_rotation_settings`, `_credential_leases`, `_session_account_pins`,
`_capacity_waiters`, `claude_subscription_account_usage`), the synthetic
subjects `worker:xai-workspace` / `worker:claude-workspace`
(`subscriptionPoolWorkerSubject`), the 0234/0598 SQL functions and their v1
accepted authority (`{version:1, scope: workspace|organization}` or
`{version:1, scope:"user", authorityGeneration}`).

M4 builds on the provider-neutral extraction ("M4-A", §5.1.2 and the
TypeScript extraction that follows it), which was planned separately and is
reconciled here with what it delivered:

- The generic logic of `packages/db/src/subscription-core-codex*.ts` moves to
  provider-neutral modules under `packages/db/src/subscription-core/`; Codex
  is an adapter and binding over them, with no behaviour change.
- Codex-named generic SQL has provider-keyed equivalents (migration 0707,
  §5.1.2) that the TypeScript core calls with `provider` as an argument: the
  turn and connection refresh seams, the connection credential read, the
  `refresh_write` and owner capabilities, the connection target and writer
  context, health, v2 accepted authority and the personal writers. This plan
  calls them by role (for example "the core refresh seam").
- Not taken by M4-A, so PR 0 does them: `list_organization_codex_workspace_ids`
  and the scope visibility and wake routines; the provider-keyed cutover
  planner (`codex-subscription-core-cutover.ts`: scope choice, assignment
  policies, delegated manager, dedupe and the policy union); the
  auto-assignment table `opengeni_private.subscription_codex_auto_assignments`,
  its apply routine and triggers; `record_subscription_codex_plan_change`;
  and 0702's access editor helpers `subscription_codex_reach` and
  `set_subscription_codex_reach`. The 0691 operation kinds below are also
  still Codex-only. PR 0c ("PR 0c: provider-keyed cutover planner and
  organization reach", below) makes all of these provider-keyed except the
  operation kinds.
- A guard test rejects provider names and provider conditionals in shared
  core modules. Every M4 change below keeps that guard green: provider facts
  live in adapters and capability flags only.

If M4-A is not merged when an M4 PR starts, that PR waits for it; M4 never
adds `xai`- or `claude`-named copies of a Codex routine.

#### Entry points

Every SuperGrok and Claude entry point in the inventory moves to the path
below. "Core" means the provider-neutral repository, SQL authority and the
named adapter; no entry point keeps its own selector, pin writer, lease table
or refresh call.

| Inventory | Today (v1) | M4 path |
| --- | --- | --- |
| EP-T01, EP-T03 chat placement (both) | `selectScopedSubscriptionTurnCapacity` (`agent-turn/xai-capacity.ts`), `selectSubscriptionAccount`, factory pins, synthetic subject for shared pools | Core placement with `provider`, the turn's accepted authority (v2 entry or compatibility record, below), session owner and attempt fence, under `withSubscriptionCoreAcceptedTurn`; one session binding; core turn lease. xAI's pre-selection quota refresh becomes a core quota observation (adapter `fetchUsage`) through the connection seam, not a list-all refresh. |
| EP-T04 materialization, refresh and request custody | Claude `resolveClaudeAccountCredential`; xAI `buildXaiTurnRequestAuthorization` / `materializeXaiCredentialForRun`; serialized legacy refresh | Core materialization and the core refresh seam (advisory key, exact turn and live lease, generation compare-and-swap); adapter `transport` and `refresh`. Every physical model request, including each xAI hosted-search continuation, reserves a `model` operation row as Codex does (`reserveSubscriptionCoreCodexRequest` generalized); an in-turn usage precheck uses `credential_request`. A request whose outcome is unknown is never replayed automatically; typed refusals (429, 529, SSE capacity terminals) are known outcomes. Claude's `user` snapshot is no longer labelled `workspace` in run settings; `credentialBinding.credentialVersion` becomes the refresh generation and the run sees only a connection id. |
| Session-title requests | `sessionTitleXaiRequestContext`; Claude title path through `withClaudeUsage` (`run.ts`) | The core title-request path Codex uses (`titleRequests`): same lease, request custody and usage recording as a chat request. |
| Claude `claudeAuthRecovery` turn metadata | `session_turns.metadata.claudeAuthRecovery {credentialId, credentialVersion}` read in `claim.ts` and `failure-settlement.ts` | Replaced by core turn-failure receipts. The cutover converts each live value into a `subscription_turn_failures` row for the alias-resolved connection with the recorded generation as recovery evidence, so the one-forced-refresh bound survives; the metadata stays as history and is no longer read. |
| EP-S18..S24 acceptance writers | `packages/core/src/domain/sessions.ts`, `domain/scheduled-tasks.ts`, `goal-admission.ts`, `session-queue-commands.ts`, `child-outbox-authority.ts`, `claim_session_system_update_outbox` (0234) | X2b/C2b: write the provider's v2 entry at acceptance, and copy compatibility records along every path listed under "Accepted authority across the cutover", dormant until the provider's receipt. |
| EP-T05 lease heartbeat and dispatch fence | `ScopedSubscriptionTurnLease` keyed by subject | Core `SubscriptionTurnLease` (already shared); `ScopedSubscriptionTurnLease` deleted. |
| EP-T07 failure settlement | `failure-settlement.ts` Claude/xAI arm, `classifyXaiCredentialFailure`, `classifyClaudeCredentialFailure`, legacy arm and reconcile | Adapter `classifyError` into shared outcomes; core turn-failure receipts, quarantine, failover bound and wait. Claude's `claude_token_renewed` / `claude_credential_changed` recovery becomes the core rule "unauthorized: one forced refresh under the lock, then retry the same connection if the generation advanced". Claude 529 stays in the provider-overload lane (`overloaded`), never account rotation. |
| EP-T08 finalization | Claude usage receipts; xAI per-turn quota fetch; factory lease release | Core lease release and binding clock. Claude header usage (EP-N25) is decoded by adapter `decodeQuota` and recorded against the leased connection with the observed refresh generation. The xAI per-turn billing call is removed; quota is observed on refusal and by the bounded out-of-turn probe. |
| EP-T09, EP-T10 waits and wakes | `getCodexCapacityWait` probes the xAI then Claude factory waiters; `reconcileCodexCapacityWait` branches on `provider`; `wakeSubscriptionCapacityWaiters`, `wakeOrganizationPool` | Core waiter and wake outbox. Activity and signal names, the optional `provider` field and its "absent means Codex" meaning stay for the legacy peek; core reconciliation looks the waiter up by its id and generation regardless of `provider`, so a recorded `provider: "xai"` or `"claude"` reconciles against the core waiter with the same preserved waiter id and generation. Organization wakes use the provider-neutral workspace enumeration. |
| EP-T11..T15, EP-N27 accepted authority, goals, children, inbox, schedules | v1 readers in `accepted-subscription-authority.ts`, `session-queue-commands.ts`, `child-outbox-authority.ts`, `parent-wake.ts`, `scheduled-tasks.ts` (xAI human from `createdBy`, Claude from `ownerSubjectId`) | After the provider's cutover: the v2 entry written at acceptance, else the copied compatibility record, else no personal authority, through one provider-neutral reader. Schedules use the revision's authorizing membership for every provider (ends the EP-N27 asymmetry). |
| EP-T16 compaction | Same capacity phase; cancelled with `requestPreserved` when no account | Core compaction placement exactly as Codex PR 2c (cancel, never park). |
| EP-T17, EP-N12 in-turn video funding and selection | Live acceptance for non-xAI turns, un-leased `selectXaiCredentialForUse`, writes a policy pin | Per-operation core placement under the turn's accepted xAI authority with a `video` operation lease keyed by turn and call; never reads or writes the chat binding. An xAI turn prefers its own live chat connection. |
| Claude custom-model admission (`organization-model-providers.ts`) | Session creation reads the new session's `initial_claude`; fresh prompts pass the snapshot computed at acceptance; scheduled-task updates pass the task's frozen snapshot (`domain/scheduled-tasks.ts`). Admits only `organization` with a live organization Claude account (`workspaceClaudeSubscriptionActiveForAuthority`) | After C3: session creation and fresh prompts are always new acceptances and admit when the workspace's effective Claude source admits organization connections and a serviceable organization-scoped Claude connection exists. Scheduled-task updates read the task's `scheduled_task` record (admit only when `shared_pool` is `organization`) or, for post-cutover tasks, apply the same source rule; the liveness requirement stays in both cases. |
| EP-T18, EP-S25, EP-N26 model listing and readiness | `loadWorkspaceModelSelectionInput` with frozen v1 snapshots; `connectionRestrictionsAndXaiReadiness`, `loadWorkspaceClaudeSubscriptionReadiness` | The core eligibility projection used for Codex (shared pools; personal only through the owner-only reader in the owner's Personal workspace or for an exact accepted turn). |
| EP-N03 SuperGrok transcription | Caller's live pool, personal wins, no lease | Codex PR 2c rule: sessionless `transcription` operation lease on a shared organization- or workspace-scoped connection; personal and people-scoped refused; once selected, failures are not retried through another provider. |
| EP-N05, EP-N07, EP-S17 realtime | Caller's live pool, writes the session pin, no lease | Codex PR 2c rule: the session's recorded owner, shared capacity only, `realtime` operation lease through negotiation, refresh under the lock; never writes the binding. |
| EP-N09, EP-N10 SuperGrok image | Turn credential; no dispatch-rejection hook | `image` operation lease keyed by turn and call; add `isProviderDispatchRejected` so a refused lease or fence returns the ledger row to `prepared` instead of outcome-unknown. |
| EP-N11 video policy route | Saving administrator's live pool | "A shared xAI candidate exists for this workspace" (no viewer, no personal). |
| EP-N13, EP-N14 video admission and reconciliation | Envelope with access and refresh token; organization scope rejected; direct `refreshXaiToken` outside the lock | The operation references the canonical connection; reconciliation reads the credential through the core connection seam under the operation's `video` lease and refreshes only under the core lock. No token envelope, so both defects disappear. |
| EP-N19, EP-N20 funding and attribution | Static overlay for xAI and Claude | Core funding result with explicit workspace, owner, accepted authority and model (the Codex `isCodexBilledTurn` rule, provider-neutral); `model_call_facts.connection_id` attribution. |
| EP-N22, EP-N23 xAI quota refresh and status probe | List-all refresh; a third auth-context copy | Core quota probe per connection with explicit context (adapter `fetchUsage`); the status route reads the effective primary through the connection seam and adapter `liveModels`. |
| EP-N24, EP-S13 Claude usage | `refreshClaudeAccountUsage`, `claude_subscription_account_usage` | Same routes over the core quota row and connection seam; `scope_required` and `reconnect` stay response values. Dead connection-based usage code is deleted. |
| EP-N28 and M1 shadow | Shadow for Claude and SuperGrok | Removed per provider at its legacy deletion. |
| EP-S09, EP-S10 pool routes; EP-S11, EP-S12 Claude OAuth and setup token; EP-S14, EP-S15 SuperGrok connect and status; EP-S16 access policy | Factory repository, `create_*` / `disconnect_*` SQL, per-pool rotation and active pointer | Same paths, verbs and payloads as adapters over core connections and settings with alias translation (Codex PR 3b pattern). `scope: "user"` connects create a personal connection; workspace and organization connects create shared connections. "Activate" sets the provider's effective primary at the scope the caller administers; rotation maps to `spread` / `primary_first`. |
| EP-S26..S31 SDK, React, web, events | `turn.capacity_waiting`, `session.status.changed` reasons `xai_capacity` / `claude_capacity`, child notices | Unchanged names and shapes, emitted as aliases of canonical subscription events; SDK methods and types kept. |
| Fences: 0608 inbox, 0275/0478 scheduled admission, 0263 membership lifecycle | 0608 compares the xAI and Claude v1 columns; 0275/0478 compare only xAI (snapshot, subject and live user authority); nothing in SQL compares Claude in scheduled admission | PR 0 extends 0608 and scheduled admission to compare the v2 slot (all providers) and adds the missing Claude comparisons and `scheduled_claude_authority_changed`. v1 equality comparisons stay and keep passing because derived rows copy v1 verbatim ("v1 columns after a provider's cutover"); the v1 liveness check switches to the core check at the receipt. Compatibility records are written after their carrier, so their equality is enforced by the deferred constraint trigger, not by the `BEFORE INSERT` fences. 0263 already handles `claude_subscription` and `subscription_connection` (0642). |

#### Adapters and shared-core additions

| Member | SuperGrok adapter (`packages/xai-subscription`) | Claude adapter (Anthropic path in `packages/runtime`) |
| --- | --- | --- |
| Sign-in and credential format | Device code; `{version:1, accessToken?, refreshToken?, sessionToken?, cookie?}`; provider account id is the token identity subject; email from the identity. | OAuth paste code (`{version:1, token, identity{accountUuid, deviceId}, oauth{refreshToken, expiresAt, scopes}}`) or setup token (no `oauth`). Provider account id is `accountUuid`, else `oauth:`/`setup:` plus an HMAC; setup tokens have no email. |
| Refresh | OAuth refresh; the refresh token rotates. | OAuth refresh; setup tokens do not renew. Legacy `version` does not move on refresh, so only `refresh_generation` fences observations. |
| Quota | Billing endpoint (`fetchUsage`) and refusal facts. | `api/oauth/usage` (needs `user:profile`, else `scope_required`) and rate-limit response headers; per-model cooldowns. |
| Error classification | 401, `unauthorized`, `invalid_token`: unauthorized; 403: forbidden; rate-limit terminals, including HTTP 200 SSE capacity terminals: rate_limited or exhausted. | Reconnect-required and 401: unauthorized; 429: rate_limited with the model; 529: overloaded; 403: fatal (legacy does not rotate on it). |
| Catalog | Live model list (`liveModels`), cached per refresh generation. | Static product catalog; per-model cooldowns. |
| Capabilities | `autoRenews`, `realtime`, `fundsMedia`, `quotaWindows`. | `autoRenews` by credential format, `quotaWindows`. No plan entitlement (`modelEntitlements` false); per-model cooldowns come from `rate_limited` with a model. |
| Cache facts | Measured idle cut-off. | Exact TTL (5 minutes by default, as Opengeni sets it). |

Shared-core additions, all in the generic precursor:

| Addition | Why it is provider-neutral |
| --- | --- |
| Capabilities may depend on `credential_format` (`capabilitiesFor(format)`); the core never calls `refresh` when `autoRenews` is false. | Any provider can offer renewable and non-renewable credentials (OAuth and setup token; API keys never renew). The static flag is documented as "false for setup tokens", which one adapter cannot express. |
| `rate_limited` and `exhausted` outcomes carry an optional `modelId`, recorded as a model cooldown. | `modelCooldowns` is already in §2.2; the outcome type cannot reach it yet. |
| Optional adapter members `fetchUsage(transport)` and `liveModels(transport)`. | Out-of-turn quota probes and live catalogs exist for Codex too, as Codex code paths. |
| Operation kind `video` in `subscription_operation_leases`. | Any `fundsMedia` provider; guard rules are those of `image` (an exact turn for personal access). |
| The `model` and `credential_request` operation kinds and the unknown-outcome replay fence (0691, 0697, 0699) are no longer Codex-only. | Per-request custody and "never replay an unknown outcome" are provider-neutral rules; 0691's CHECK admits these kinds only for `provider = 'codex'`. |
| Wait reason `accepted_authority_unavailable`. | Work whose accepted authority cannot be used (decision 4) waits with a typed reason for any provider. |
| Lifecycle fact `model.connected` captured on core connection insert, keyed by provider. | Today it is emitted only by triggers on the legacy credential tables (0565, 0598, 0602); Codex already lost it in M3. |
| `subscription_authority_compat` relation, its reader and copy routines (below). | Keyed by provider and carrier; needed by every provider whose v1 snapshot predates its cutover. |
| Provider-keyed cutover receipts, readiness and parity report (below). | Replaces per-provider receipt functions and report relations. |

#### Accepted authority across the cutover

Since 0689 every live accepted-work row carries a v2 value holding only
Codex entries, and v2 is immutable, so a later provider cannot be backfilled
into v2. Decision: the drained cutover writes one immutable compatibility
record per carrier and provider in `subscription_authority_compat`.

Shape: `account_id`, `provider`, `carrier_kind`, one typed reference per kind
with its own foreign key and `ON DELETE CASCADE` (`session_id` for
`session_initial`; `workspace_id, turn_id` for `session_turn`;
`scheduled_task_id` for `scheduled_task`; `scheduled_task_id,
task_authority_revision` for `scheduled_task_revision`; `system_update_id`
and `outbox_id` for `session_system_update` and
`session_system_update_outbox`), a CHECK that exactly the kind's columns are
set, a unique key per carrier and provider, `personal`, `shared_pool` and
`legacy_scope` (`organization`, `workspace`, `user`, or `missing` for the
fail-closed backstop below; copied unchanged).
UPDATE is always rejected; DELETE happens only by cascade from the carrier,
so session, task and organization retention keep working.

Carriers written by the cutover are every row a later read or copy can use as
its source, not only live work:

- non-terminal turns, live scheduled tasks and their current revision,
  pending system updates and outbox rows;
- for every session that is not deleted, its execution-context turn and its
  latest accepted turn (even when terminal), or a `session_initial` record
  from `sessions.initial_*` when it has no turn;
- for every child session that is not deleted, its `parent_turn_id` turn
  (parent wakes and child results read it), including children that have no
  turn yet.

Record content:

- `personal` is empty or one entry `{ownerMembershipId, authorityGeneration,
  connectionIds}`. Unlike a v2 entry it lists the exact canonical
  connections, because a v1 `user` snapshot authorized only that person's
  credentials in the session's workspace, and personal connections are no
  longer workspace-bound. `authorityGeneration` is the owner's single cutover
  generation G (see "Personal authority generations" below).
- `shared_pool` is `workspace`, `organization` or `none` and narrows shared
  candidates to that `inference_pool` classification (the §5.2 assignment
  relation) for this work only. Live eligibility still applies; the record
  only narrows.

Reading:

- After the provider's cutover: the v2 entry for that provider if present,
  else the compatibility record. Before the cutover v1 stays authoritative
  and neither is read. A carrier has at most one of the two: pre-cutover
  carriers get a record and have no entry; post-cutover acceptance writes the
  v2 entry and no record.
- Fail-closed rule: "no personal authority and no narrowing" applies only to
  work accepted after the provider's receipt. A carrier or receiver source
  created before the receipt (`authority_inserted_at`, below, earlier than
  the receipt's `committed_at`; the cutover is drained, so no row is created during it)
  that has neither yields `personal: []`, `shared_pool: none`, and the work
  waits with `accepted_authority_unavailable`. It never falls back to no
  narrowing. The same holds for work derived after the cutover from such a
  source: its copy routine writes `{personal: [], shared_pool: none,
  legacy_scope: missing}`, and
  the deferred trigger fires whenever the resolved source predates the
  receipt, not only when the source has a record. "Created before the
  receipt" is decided by a server-owned marker, not by `created_at` (which
  current and older binaries set from the application clock and which some
  ordering relies on): PR 0 adds `authority_inserted_at timestamptz NOT NULL
  DEFAULT transaction_timestamp()` to every carrier table (a metadata-only
  change; existing rows get the PR 0 time, before any receipt), a `BEFORE
  INSERT` trigger that overwrites any supplied value with
  `transaction_timestamp()`, and a `BEFORE UPDATE` trigger that rejects
  changing it. Explicit values are replaced, never rejected, so rolling
  inserts keep working. The column adds and trigger creation on busy tables
  (`session_turns`, `sessions`) run under `SET LOCAL lock_timeout` as 0667
  does, so the deploy fails fast instead of queueing behind a long
  transaction.
- That wait, and every wait caused by a record with `personal: []` and
  `shared_pool: none`, ends at the existing capacity-wait deadline with a
  typed turn failure the session owner sees ("this work was accepted before
  the account move and its account access could not be carried; send it
  again"). A new message is accepted afresh and writes v2. The parity report
  counts these carriers (`compat:carriers_that_will_wait`) so operators see
  the impact before the window: records with `personal: []` and
  `shared_pool: none`, `user` records whose session is neither private nor
  in the owner's Personal workspace (both helpers refuse them), and
  non-owner-caused `workspace` records in a Personal workspace.
- `authorize_subscription_personal_access` and
  `authorize_subscription_personal_placement_access` (0667) both require
  `connection.id = ANY(connectionIds)` for record-based authority; the
  placement helper never mints personal access by membership and generation
  alone for a record. v2-based authority keeps the §3.8 rules.

Writing:

- Runtime roles have no INSERT, UPDATE or DELETE on
  `subscription_authority_compat`. Records are written only by the migration
  owner and by `SECURITY DEFINER` copy routines that compute the copy in SQL
  from the verified exact source and accept no caller-supplied content (the
  0688 revision-trigger pattern of keeping a caller-supplied value is not
  reused).
- One SQL source resolver per carrier path, shared by the copy routine, the
  deferred trigger below and PR 0's v2 fence comparisons. The sources are
  those today's code uses for v1 and Codex v2:

  | Path | Source |
  | --- | --- |
  | Agent Message, Agent Steer, agent-submitted prompts | The receiving session's source (`accepted-subscription-authority.ts`): its execution-context turn, else its latest accepted turn, else its spawning parent turn, else `session_initial`. Not the sender's `callerTurnId`, which 0608 uses only for its human-equality check. |
  | Informational delivery into a context | The receiving context turn. |
  | Causal delivery (child results through the outbox, background results, wait timeouts) | The delivered update or outbox row, whose own record came from its causal turn (the spawning parent turn for child results). |
  | Pure goal continuation | The goal's causal turn when it has the same human (`index.ts` goal continuation path), not the context turn or the update. |
  | Child creation | The parent turn. |
  | Compaction | The compacted turn. |
  | Scheduled firing | The task and its current revision, with the authorizer check. |
  | Agent-created tasks; revision clones on rename or pause | The causal turn; the previous revision. |

- Narrowing: a copy keeps the personal entry only when the source's owner is
  the causal human of the new carrier (as `accepted-subscription-authority.ts`
  does today); otherwise it drops it. If dropping it leaves a record whose
  `shared_pool` is `workspace` or `organization`, that narrowed record is
  written. If the source record has `legacy_scope = user` and the copy is
  not owner-caused, no record is written: the carrier is post-receipt work
  with no personal authority and no narrowing, which with the Source mapping
  row equals today's fallback to the receiving workspace's shared pool (and
  what an empty Codex v2 means), so it never waits on
  `accepted_authority_unavailable`. An owner-caused copy of a `user` record,
  and any copy of a `missing` record, is written verbatim and stays fail
  closed. A
  record is never derived from v1 after the cutover; a new human acceptance
  writes v2.
- Commit-time enforcement: a `DEFERRABLE INITIALLY DEFERRED` constraint
  trigger on each carrier table (`session_turns`, `sessions`,
  `scheduled_tasks`, the revision relation, `session_system_updates` and the
  outbox) fires when the provider has a receipt and the path's resolved
  source has a record or predates the receipt. It recomputes the resolver's result (the source
  record, its narrowing, or no record) and requires the carrier's record to
  equal it byte for byte, and that the carrier has no v2 entry for that
  provider. The `BEFORE INSERT` fences cannot do this because records are
  written after their carrier.
- Inbox batching: the batch key (`systemUpdateExecutionAuthorityKey`), the
  receiver-context comparison and the 0608 fence add the provider's effective
  authority (v2 entry, record, "post-receipt, none", or "pre-receipt
  source without either", which resolves to the waiting `missing` copy) after
  the receipt,
  because the post-cutover v1 default equals a real pre-cutover `workspace`
  value; the deferred trigger checks every delivered update of a batch, so a
  narrowed and an unnarrowed update never share a delivering turn.
- System updates and outbox rows store no human (0689 froze an empty v2 on
  them). Their record's owner is the human of their causal turn; when that
  turn has none, the narrowing rule above applies.
- Archived-session imports (which backdate `sessions.created_at`) get a
  post-receipt `authority_inserted_at` and therefore count as new
  acceptances: no personal authority and no narrowing, never a record.
- FORCE RLS; visibility follows the carrier's session or task. Parity metric
  `compat:dependent_sources_without_record` must be zero at the cutover, and
  X4/C4 (deleting the v1 readers) may merge only with a test proving it for
  every copy path.

| v1 snapshot | Compatibility record |
| --- | --- |
| `organization` | `personal: []`, `shared_pool: organization`. |
| `workspace` in a shared workspace | `personal: []`, `shared_pool: workspace`. This also preserves the legacy default for non-human acceptance (EP-T11): work accepted as `workspace` in a workspace without its own accounts keeps waiting as it does today. |
| `workspace` in a Personal workspace whose workspace-scope credentials became the owner's personal connection | `shared_pool: workspace`; when the carrier is owner-caused (exact session owner, initiating human and active membership) a personal entry for the owner with G and `connectionIds` = the canonical connections derived from that workspace's credentials of the provider; otherwise `personal: []`. |
| `user` with generation g | Owner membership from the exact initiating human (scheduled work: the revision's authorizing membership, cross-checked against the legacy causal field). Eligible only when that owner's legacy `xai_subscription` / `claude_subscription` authority is, at cutover time, active, unrevoked and at generation g. The entry has G and `connectionIds` = the canonical connections of that owner's legacy `user` credentials in that workspace; `shared_pool: none`. If not eligible (revoked, stale, owner mismatch, `personalConnectionsAllowed` false): `personal: []`, `shared_pool: none`, counted as a disposition. |
| Any, non-human acceptance | `personal: []`; the shared pool as above. |

#### Personal authority generations

The core writes a personal v2 entry only when the owner has exactly one
current generation for the provider (0669, 0688, 0689), so the cutover must
not carry per-credential legacy generations (they default to 1 and coincide
across workspaces) or mint a second one. For each (owner membership,
provider) with at least one personal connection after the move, the cutover
mints one generation G, computed after all of the migration's inserts and
greater than every `subscription_connection` authority generation of that
membership for any provider and every legacy generation of that provider's
legacy resource kind for that membership. Every personal connection of that
owner and provider gets a `subscription_connection` authority row at G; the
legacy authority rows are retired as 0689 retired `codex_subscription`.
Generation numbers alone never identify connections: records also carry
`connectionIds` (above). Abort `personal_generation_ambiguous` when any owner
ends with more than one current generation for the provider.

#### v1 columns after a provider's cutover

The v1 columns on turns, tasks, revisions, system updates, outbox rows and
`sessions.initial_*` are `NOT NULL` and are compared for equality by the 0608
inbox fence and the 0275/0478 scheduled-admission and occurrence fences. Rule:
after a provider's receipt, no code computes that provider's v1 value from
live state. A new acceptance writes the column default (the constant
`workspace` snapshot, never read), and every derived row copies the stored v1
value of the same source today's code uses (the per-path resolver above)
verbatim instead of recomputing it, which is what those equality fences
already require. A copied `user` v1 value is copied together with its
lineage subject fields, which `frozenSubscriptionExecutionAuthority` requires
alongside it. The values are never read for that provider after its receipt, and
X4/C4's guard rejects readers. Runtime roles keep INSERT on these carrier
columns until M6; the revoked write grants apply to the factory tables and
legacy authorities only.

The fences live in `admit_scheduled_agent_run_execution` (0478 restated it
with the 0416 and 0447 changes included; 0501 patches it in place after
0478),
`validate_scheduled_occurrence_accepted_execution`,
`fence_scheduled_occurrence_update`, `fence_scheduled_turn_execution_update`
and `fence_inbox_execution_context` (0608). The one v1 liveness check,
`scheduled_xai_authority_changed` in
`validate_scheduled_agent_run_live_authority` (0478; originally 0275; called
from 0447, 0452, 0459 and the scheduled path in `packages/db/src/index.ts`,
which all inherit the new `scheduled_claude_authority_changed` refusal and
are named in PR 0's inventory and tests), is replaced at the receipt by the equivalent
core check on the revision's record or v2 entry (the personal entry's G is
current for its membership and its connections are serviceable), returning
the same code. PR 0 adds the missing Claude comparisons (finding below) and
the matching `scheduled_claude_authority_changed` check, with the same
receipt switch. PR 0 changes these functions by patching the live definition
with the drift-checked `pg_get_functiondef` plus anchored `replace` pattern
the earlier patches use, never by restating an older body. Tested after PR 0
(existing runs, occurrences, generated sessions and inbox deliveries written
by older binaries) and after X3, X4, C3 and C4: scheduled tasks created before
the cutover on Codex, Claude and xAI models still admit occurrences, and an
inbox batch is still delivered into a pre-cutover execution context.

#### Data mapping

The mapping is the same for SuperGrok and Claude except where noted. Every
move runs inside the drained owner window of that provider's cutover and
touches only that provider's rows.

| Legacy | Core |
| --- | --- |
| Credentials, `authority_scope = workspace` (shared workspace) and `organization` | The M3 planner rules apply unchanged, keyed by provider (`subscription-core/cutover-plan.ts`, made provider-keyed by PR 0c; Codex passes its rules from `codex-subscription-core-cutover.ts`): after dedupe, a group gets `organization` scope only when it has a single organization source with a NULL `allowed_workspace_ids`, `allow_personal_workspaces = true`, and an allocator and model policy equal to the union; otherwise `workspaces` scope listing every reached workspace, with auto-assignment rows for organization sources with a NULL list so later workspaces still join, and Personal workspaces only where `allow_personal_workspaces` admitted them. One assignment policy per `(workspace, inference_pool)` source with its exact model allowlist, allocator state and manager. `managed_by_workspace_id` is set only when the group has a single workspace-scope source; otherwise NULL and per-workspace management comes from the assignment policies. Parity metric `organization_reach_auto_assigned`. |
| Credential, `workspace`, Personal workspace | Personal connection of the workspace owner with a `subscription_connection` authority at the owner's cutover generation G ("Personal authority generations"); §5.2 fallback settings (opt-in plus the workspace `personal_fallback_allowed` override; an organization lock of `false` stays and is a disposition). |
| Credential, `authority_scope = user` | Personal connection with the same `owner_organization_membership_id`, not workspace-bound. The canonical connection gets a `subscription_connection` authority at the owner's single cutover generation G ("Personal authority generations"); legacy generations are not carried, and the legacy authority row is retired as 0689 retired `codex_subscription`. The row's model allowlist becomes the personal ceiling. The origin workspace stays as authority provenance. |
| Credential, `user`, organization with `personalConnectionsAllowed = false` | Still becomes the owner's personal connection (the data is preserved), but it is unusable while the organization forbids personal connections; counted as disposition `personal_connections_disallowed`. Compatibility records for its pre-cutover work get `personal: []` (decision 4: such work waits). |
| Identity and dedupe | Group by organization, provider, provider account id, person and owner (personal membership or shared). xAI: the person is the token identity subject; a stored id that contradicts the decoded token aborts (`provider_identity_mismatch`). Claude: the person is `accountUuid`; `oauth:`/`setup:` HMAC ids are their own person key and never merge with another id, and OAuth and setup-token rows never merge. Rows without an id stay separate. Canonical row: active, error, needs_relogin, disabled, then freshest refresh, then id; the others become aliases. Model policies merge with the 0689 enabled-only union. Ambiguous owner or scope aborts before any write. |
| Secret | Decrypted and re-encrypted in the codec stage, canonicalized to the adapter format, read back, digest parity, then the legacy ciphertext is blanked (one secret copy). `credential_format` is set per row (for example `xai_oauth_v1`, `claude_oauth_v1`, `claude_setup_token_v1`). |
| Health and quota | Status 1:1. Both the connection `version` and `refresh_generation` start from the legacy `version`, for both providers. xAI `quota_used_percent`, `quota_reset_at` and `exhausted_until` become one quota window and `exhaustedUntil`, whose kind is `rate_limit` when the legacy `last_error` records a rate-limit refusal and `quota` otherwise. Claude usage windows and `model_cooldowns` move to the quota row; the observed generation is set only when the usage row's `credential_version` equals the credential `version`, else NULL (unknown, never exhausted). A usage `reconnect` flag stays a quota fact and does not change status. Allocator counters: `selection_count` is summed and `last_selected_at` maxed over the group into the connection's quota row; the rotation row's `fairness_cursor` has no core column and is a disposition (core `spread` orders by a per-session hash and keeps no cursor). |
| Rotation settings | Only pools in effect map: the organization row to organization `rotation.<provider>`, workspace rows to workspace overrides. Rotation on (also when no row exists) is `spread`; off is `primary_first` with the alias-resolved active pointer as the provider primary. User-pool rotation rows have no equivalent (disposition). |
| Source | Legacy acceptance used the workspace pool when the workspace had its own credentials, else the organization pool; it never admitted organization accounts while local accounts existed. A workspace with workspace-scope credentials of the provider gets `inference_source = workspace`; other workspaces get no override (`automatic`, which today admits only organization connections there). `enabled` stays true. This deliberately diverges from §5.2's Codex `automatic` row (no override, rotation to keep local first): legacy Codex `automatic` already mixed both pools, so leaving it automatic was exact, whereas freezing `workspace` is the exact preservation for SuperGrok and Claude and the strictest one. Release note: such workspaces stop using organization accounts only if an administrator later changes the source, as today. |
| Session pins | One binding per session, for the session's current model provider. Among that provider's pool rows, the row of the pool in the session's latest accepted v1 snapshot wins. A manual pin is `explicit` (owner-only, non-dispatching seam; kept when unhealthy); a policy pin, else the last account, is `automatic`. A personal target is kept only when the session owner owns it and the session is private or in their Personal workspace; otherwise disposition `pin_owner_ineligible`. An existing binding for the current provider is kept and this provider's rows become dispositions; a binding for another provider is replaced only when the session's current model provider is this one. `last_model_call_at` comes from the latest model-call fact. |
| Leases | Live leases move with turn, holder, generation, expiry and the alias-resolved connection; parity compares exact tuples. Expired leases are a disposition; a live core lease on the same turn aborts (`lease_conflict`). |
| Waiters | Only `waiting` rows whose blocked turn and generation equal the session's parked turn move; others collapse with a disposition. When several of the provider's pool waiters match the parked turn, the one for the pool of the turn's v1 snapshot moves (the `user` pool for a `user` snapshot). Preserve the legacy `id` as `waiter_id`, `generation`, `wake_revision`, `observed_wake_revision`, `next_check_at`, `earliest_reset_at`, `blocked_turn_generation`, the goal fence and `last_wake_reason`. `wait_reason` takes a core value: `pinned_account_unavailable` or `pinned_account_ineligible` for a pinned wait, `model_not_allowed` for a model policy refusal, else `no_eligible_capacity`; `reset_kind` `quota` only when a reset is known. `workflow_id` must equal the session's workflow id, else abort. Any existing core waiter for the session aborts the cutover (`waiter_conflict`); the migration never modifies Codex or other-provider core rows. A pending wake (`wake_revision > observed_wake_revision`) gets a wake-outbox row. |
| Accepted authority | Compatibility records on every carrier listed under "Accepted authority across the cutover" (live work plus each session's execution-context, latest accepted and child-parent turns, or `session_initial`). v1 columns and existing v2 values are not modified. |
| Media and transcription ledgers | Non-terminal xAI video operations get the canonical connection and a `video` operation reference; their envelopes are blanked after parity. Non-terminal image operations keep their recorded identity and resolve the recorded credential through aliases; nothing is reissued after an uncertain write. Transcription holds no durable credential state. |
| Read-only legacy | Factory tables, `claude_subscription_account_usage`, `opengeni_private.{xai,claude}_subscription_runtime_capabilities`, and the legacy `xai_subscription` / `claude_subscription` resource authorities stay read-only for forensics until M6; v1 columns on carriers follow "v1 columns after a provider's cutover" (still written, by default or verbatim copy, never read). Runtime roles lose write grants on them through role provisioning (`provision-roles` stops granting them once the provider's receipt exists) and the deployed runtime-posture contract, which X3/C3 extend and assert; a revocation inside the migration alone would be re-granted by the next `provision-roles`. Claude's revoked legacy model connections stay; any non-revoked one aborts the Claude cutover. |

#### Cutover protocol

Each provider has one drained maintenance migration with a codec stage, as
0689. The steps of §5.1.1 "Data move and cutover protocol" and of PR 3 apply,
with these provider-neutral changes:

- **Receipt and readiness.** The precursor adds
  `opengeni_private.subscription_provider_cutover_receipts (provider,
  migration, committed_at)` and one readiness function taking `provider`; the
  Codex receipt function stays. A provider cut over before PR 0 (Codex) is
  recorded with `committed_at = '-infinity'`, so the time-based backstop never
  treats its existing work as pre-receipt (Codex work mostly carries no
  personal v2 entry and never gets a compatibility record); PR 0 tests that
  Codex follow-up work accepted before PR 0 still runs after it. A binary
  requires the receipt of every provider whose cutover migration is in its
  own ledger and refuses to start otherwise. Readiness is answered by the SQL
  readiness function (a boolean per provider); TypeScript never reads
  `committed_at` as a date (the database driver turns `-infinity` into an
  invalid date), and the readiness test includes the Codex row.
- **Switch rows before the receipt.** Runtime roles may not insert, enable or
  delete a `subscription_provider_cutovers` row, nor insert core connections,
  for a provider without a receipt. With the receipt, the row is undeletable
  and cannot change provider or organization, disabled means fail-closed
  maintenance, and a provider-neutral trigger seeds new organizations for
  every provider with a receipt. That trigger replaces 0689's Codex seed
  trigger in the same PR 0 migration (both insert without `ON CONFLICT` into
  unique tables, so keeping both would fail every organization creation),
  seeds Codex exactly as 0689 does today (switch row and account-level
  settings row), updates the posture inventories, and is tested by creating
  an organization after PR 0.
  0689's seed-only insert policies (`subscription_provider_cutovers_codex_seed`,
  `subscription_settings_codex_seed`) and their setting
  (`opengeni.subscription_codex_cutover_seed`) are generalized in the same
  migration: they keep the owner, per-organization, enabled-row and
  organization-level checks and replace `provider = 'codex'` with "this
  provider has a receipt", so the seed path can never create an enabled row
  for a provider before its receipt. The account-level settings row is
  unique per organization, so it is inserted once with the defaults of every
  provider that has a receipt.
- **Owner-only routines in rolling migrations.** PR 0 and every later rolling
  M4 migration put new owner-only routines (the seed, the
  `authority_inserted_at` triggers, the deferred compatibility triggers, the
  copy routines' implementations) in `opengeni_subscription_internal`, as M3
  did (§5.1.1), not in `opengeni_private`, where the previous release's
  runtime-posture readiness would reject a routine the runtime role cannot
  execute and does not list as owner-only. The replacement seed may instead
  keep 0689's seed function name and replace its body. Each such PR tests the
  previous release's posture check against its schema.
- **Parity report.** One relation
  `opengeni_private.subscription_cutover_report (provider, metric,
  account_id, legacy_count, core_count)`; each migration writes only its
  provider. Metrics: credentials and secret readability per source scope,
  identities, aliases, scopes and assignments, model policies, allocator,
  managers, effective source and rotation, primaries, bindings, live lease
  tuples, waiter ids, generations and revisions, compatibility records per
  carrier kind, `compat:dependent_sources_without_record`, `compat:carriers_that_will_wait`, current personal generations per owner, `organization_reach_auto_assigned`, video operations, and dispositions (`disposition:*`).
- **Aborts** (content-free, `55000`): drain check, undecodable credential,
  identity or owner ambiguity, pre-existing core rows for the provider, lease
  or waiter conflict, waiter workflow mismatch, a non-revoked Claude legacy
  connection, `personal_generation_ambiguous`, any parity mismatch. The
  runbook's inventory queries list pre-existing core connections and switch
  rows for the provider (possible before PR 0, finding 1) before the window;
  they were never usable, the operator removes them, and the abort stays the
  backstop. Errors never carry statement parameters.

Ordering decision: **explicitly ordered, data-independent.** The ledger places
the SuperGrok cutover before the Claude cutover because the PRs merge in that
order; accepting either order would need two migration variants. Each
migration commits in its own transaction, touches only its provider's legacy
rows and its provider's keys in shared relations (settings keys, primaries,
cutover rows, compatibility records, report rows), and never reads the other
provider's moved data. Therefore:

- **One window:** drain, back up, upgrade straight to the Claude cutover
  release; the migrator applies the SuperGrok then the Claude cutover;
  provision roles; start; validate both reports.
- **Separately:** upgrade to the SuperGrok cutover release in one window and
  to the Claude cutover release in a later one.
- If the Claude cutover aborts in a combined window, SuperGrok stays cut over.
  The operator fixes the named rows and reruns, or starts the SuperGrok
  cutover release. That is safe only because the Claude cutover release
  contains nothing after the SuperGrok cutover ordinal except rolling
  migrations and the Claude cutover; a ledger test in the Claude cutover PR
  enforces this.

Each cutover is the one-way point for its provider: no older binary restarts
after its commit, there is no down migration, and recovery is fix-forward with
an idempotent, alias-aware, parity-checked repair while affected
organizations are held behind a disabled switch row. Never copy rows back,
drop aliases, reset generations or clear waiters. Each cutover PR adds its own
`docs/deployment.md` section ("SuperGrok on the shared subscription core" and
"Claude on the shared subscription core", with the ordinal) mirroring the 0689
runbook: inventory queries, drain with the complete runtime-login list,
backup, migrate with `OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES` and
`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`, provision roles, validate the report
filtered by provider, containment, fix-forward and release notes.

#### PR sequence

Each X and C PR is dormant behind the provider's switch until its cutover;
without a receipt the legacy path runs unchanged after at most one receipt
read. PR 0 is not dormant: its v2 fence comparisons (live for Codex, which is
cut over), its Claude scheduled comparisons and its replacement of 0668's
non-Codex branch act on deploy. Its v2 comparison for each delivery kind uses
the per-path resolver (a pure goal continuation compares with the goal's
causal turn, not the context turn), and its PR records a pre-merge inventory of
existing rows that the new Claude comparisons would reject, including live
scheduled tasks whose Claude snapshots already disagree, so they are resolved
before the comparisons go live. The inventory and PR 0's tests also cover the
callers of `validate_scheduled_agent_run_live_authority` (0447, 0452, 0459
and the scheduled path in `packages/db/src/index.ts`), which inherit the new
`scheduled_claude_authority_changed` refusal.
Migration ordinals are the next free ones at merge
(`bun run migration:renumber`). Every implementation PR follows the
repository's complex-change review policy.

| PR | Content | Mode |
| --- | --- | --- |
| 0. Generic precursor | Receipt table and provider-keyed readiness; switch-row and core-connection restrictions before a receipt; compatibility relation, reader and copy routines (inert); the server-owned `authority_inserted_at` marker on carrier tables; `authorize_subscription_personal_access` (0668's legacy-generation v1 branch replaced, not generalized) and the 0667 placement helper: a provider with an enabled cutover reads its v2 entry or compatibility record and requires the exact owner membership, the current generation, `personalConnectionsAllowed` and, for records, `connectionIds`; a disabled row grants nothing; until a provider's receipt both helpers return false for that provider (`xai`, `claude`), whose personal access is decided only by its v1 path. Fences 0608 and scheduled admission also compare v2, the Claude scheduled comparisons and `scheduled_claude_authority_changed` are added, the v1 liveness check switches at the receipt, and the compatibility deferred triggers are installed. PR 0 merges before any X1a or C1a call site, because 0667 and 0668 already accept any provider; provider-checked primaries; `video` operation kind; `model` and `credential_request` kinds and the unknown-outcome replay fence widened beyond Codex; wait reason `accepted_authority_unavailable`; provider-keyed `model.connected` lifecycle fact on core connection insert; provider-keyed cutover planner and auto-assignment if M4-A lacks them; adapter interface additions; provider-keyed report relation. | rolling |
| X1a. SuperGrok adapter and chat placement | The xAI adapter and its conformance suite; chat placement, materialization, refresh, request custody (`model` / `credential_request` rows, including hosted-search continuations), session-title requests, readiness, `list_models`, funding and attribution on the core with `provider = xai`. | rolling |
| X1b. SuperGrok settlement and waits | Failure settlement through adapter `classifyError`, finalization, waits, wakes, Temporal reconciliation by waiter id, compaction. | rolling |
| X2a. SuperGrok media and probes | Image, video (funding, selection, admission, reconciliation), transcription, realtime, status and quota probes. | rolling |
| X2b. SuperGrok routes and writers | Routes, access policy, SDK and event projections; connect, disconnect and personal writers; EP-S18..S24 v2 entry writers and the compatibility copy routines on every path. Lands before X3 so connect and disconnect work after the cutover. | rolling |
| X3. SuperGrok drained cutover | Codec stage, data move, compatibility records, parity report, receipt, switch rows enabled; role provisioning and the posture contract stop granting legacy writes; runbook section. | maintenance |
| X4. SuperGrok legacy deletion | Removes the xAI selector arm, factory repository use, v1 xAI readers and writers, xAI use of `ScopedSubscriptionTurnLease`, the video envelope code and the shadow; extends the guard below to xAI. Merges only with the `compat:dependent_sources_without_record` copy-path test green. | rolling |
| C1a, C1b, C2a, C2b, C3, C4. Claude | The same steps. C1b reads core turn-failure receipts in place of `claudeAuthRecovery`; C2a covers the usage routes; C2b covers the OAuth and setup-token writers; C3 converts live `claudeAuthRecovery` values and includes the combined-window ledger test; C4 deletes the Claude arm, `claude_subscription_account_usage` use and the dead connection-based usage code. | as X1a..X4 |
| F. Fake API-key adapter conformance | A test-only adapter (`kind = api_key`, static credential, no quota windows, no refresh) driven through the same core placement, lease, failover and wait paths as subscriptions and compared with the reference model; scripted local upstream and a network-denial guard. No production table or route. | test only |
| R. Retirement | A forward migration drops the retired SQL routines, triggers and policies listed below; `subscriptionPoolWorkerSubject` and its users are removed; posture inventories are updated. Historical migrations, legacy tables and columns, v1 CHECK validators and column-immutability triggers stay until M6. | maintenance (exact posture contract) |

Retired in R, for both providers unless noted:
`create_*_subscription_credential`, `disconnect_*_subscription_credential`,
`resolve_*_authority_pool`, `revalidate_*_subscription_authority`,
`*_subscription_authority_live`, `*_subscription_pool_visible`,
`prevent_*_authority_mutation`,
`opengeni_private.enforce_*_credential_pool_reference`,
`opengeni_private.enforce_*_organization_runtime_update`,
`opengeni_private.prevent_organization_*_live_disconnect`; the factory-table
policies that call them (`*_subscription_scope`, `*_subscription_pool_scope`);
the capability policies on `organization_memberships` and
`organization_user_resource_authorities` (`*_subscription_capability_read`,
`*_subscription_capability_insert`, `xai_subscription_membership_lock`); the
`claude_usage_account_scope` policy; the triggers that call retired functions
(`xai_lease_credential_pool_guard`, `xai_pin_credential_pool_guard`,
`xai_rotation_credential_pool_guard`, `xai_organization_runtime_update_guard`,
`xai_organization_rotation_update_guard`,
`xai_organization_live_disconnect_guard`,
`xai_subscription_credentials_authority_immutable_trg` and their Claude
counterparts created by the 0598 factory); and the runtime-capability inserts
of the 0234/0598 protocol. Every drop names its object exactly, never uses
`CASCADE`, and is preceded by a catalog check that no remaining policy,
trigger, view or routine depends on it. Tables left without a policy keep
FORCE RLS and therefore deny the runtime roles, which is the intended
read-only end state for M6 forensics through the owner.
`opengeni_private.claude_subscription_pool_protocol_v1_active` stops being a
readiness requirement. Kept: `*_provider_account_authority_snapshot_v1_valid`
(CHECK constraints), `prevent_*_snapshot_mutation` (column immutability),
`reject_legacy_claude_subscription_credentials` (guards the generic
connections table) and every receipt function.

Guard: `check:no-legacy-subscription-runtime` (the Codex check generalized and
run by `check:subscription-contract`) rejects executable references to the
factory tables, `claude_subscription_account_usage`, the synthetic subjects,
the retired routine names and the v1 authority readers, outside exact
declared exceptions (retained schema and foreign keys, deployed-schema posture
inventories, historical fixtures used only by tests). The X3/C3 codec
stages and the legacy secret decoders they call
(`packages/db/src/xai-subscription.ts`, the `ClaudeSubscriptionCredential`
decoder) stay exact exceptions for as long as those migrations ship, because
a fresh install and a one-window upgrade still run them. A
real-PostgreSQL posture test asserts that every retired routine is absent and
that runtime roles hold no write grant on legacy tables. M4-A's shared-core
guard keeps provider names out of shared modules.

#### PR 0a: receipts, restrictions and personal helpers

Migration 0712 (rolling) delivers the first part of row 0. Choices made where
the plan left room, for reviewers:

- **Receipts.** `opengeni_private.subscription_provider_cutover_receipts
  (provider, migration, committed_at, seed_rotation)` is owner-only and
  append-only (update, delete and truncate raise `55000`). Codex is recorded
  with `committed_at = '-infinity'`. `seed_rotation` holds the provider's
  rotation default for the organization seed, so the seed names no provider.
  `opengeni_private.subscription_provider_cutover_committed(provider)` is
  the only reader (SECURITY DEFINER, granted to the runtime role). The binary
  lists `SUBSCRIPTION_PROVIDER_CUTOVER_MIGRATIONS` (Codex only) and refuses
  to start without each receipt; a cutover PR adds its provider.
- **Switch rows and connections.** Restrictive policies bind every role FORCE
  RLS binds (runtime, owner and owner-run routines): no insert of a switch
  row or core connection, and no enabling update, for a provider without a
  receipt. A row may always be disabled. The runtime delete policy is
  dropped for every provider, so no organization returns to "no row"; a
  provider-neutral identity trigger keeps every switch row's and every core
  connection's organization and provider, for every role (0702's scope guard
  let organization administrators change a connection's provider, which
  would have bypassed the insert restriction). Rows that already exist for
  `xai` or `claude` stay, grant nothing (below) and are listed by the runbook
  inventory.
- **Seed.** 0689's seed function keeps its name; its body seeds an enabled row
  per receipt provider and one settings row whose rotation is built from the
  receipts. The seed-only policies are generalized
  (`subscription_provider_cutovers_seed`, `subscription_settings_seed`,
  setting `opengeni.subscription_cutover_seed`). Codex is seeded exactly as
  before (tested by creating an organization on each side of 0712).
- **Personal helpers.** 0668's legacy-generation branch is removed, not
  generalized: `authorize_subscription_personal_access` grants only when the
  provider has a receipt and an enabled row, and the frozen v2 entry, exact
  owner membership, current generation and `personalConnectionsAllowed`
  match. With no row it now grants nothing for Codex either; "no row" is
  unreachable for Codex after 0689, so live behaviour is unchanged. The 0667
  placement helper's provider list becomes the receipt check. Both return
  false for `xai` and `claude` until their receipts. The compatibility-record
  branch is added with the compatibility relation (PR 0b).
- **Primaries.** Constant columns `{codex,claude,xai}_primary_provider` with
  CHECKs carry the provider into composite foreign keys on
  `(account_id, provider, id)`, `ON DELETE SET NULL` of the connection column
  only. A primary pointing at another provider's connection is cleared and
  counted as `disposition:primary_of_other_provider_cleared`.
- **Report.** `opengeni_private.subscription_cutover_report (provider, metric,
  account_id, legacy_count, core_count, recorded_at)` receives 0689's Codex
  rows; 0689's relation stays read-only. PR 0 writes
  `readiness:owners_with_multiple_current_personal_generations` for Codex
  (one row per organization and a total row with `account_id` NULL;
  `core_count` is the number of owners). The repair stays an owner decision.
- **Kinds.** `video` is added; `model` and `credential_request` are admitted
  for every provider; `apps` and 0711's `completion` stay Codex-only. The
  unknown-outcome replay fence was already keyed by the provider registry
  (0707).
- **`model.connected`.** An `AFTER INSERT` trigger on
  `subscription_connections` emits the fact with the legacy attribute
  (`codex`, `supergrok`, `claude_subscription`), keyed by connection id and
  without a workspace. A drained cutover sets
  `opengeni.subscription_cutover_provider` for its own moves, which emit
  nothing. Codex connects emit the fact again (they stopped at 0689).
- **Credential format.** 0707's neutral refresh writers stored the encryption
  envelope version in `credential_format`; they no longer touch it, so an
  adapter format such as a setup token's survives refresh. Codex stores
  `v1` either way. The neutral connect writer still writes `v1`; a provider
  with another format passes it when its writer lands (X2b, C2b).
- **Adapter.** `SubscriptionCoreAdapter.capabilitiesFor(format)` and
  `credential.format(credential)` let `autoRenews` depend on the credential
  format; the resolver and both refresh paths choose the refresher through
  `subscriptionCoreCredentialRefresher`. Optional `fetchUsage` and
  `liveModels`, a `modelId` on exhausted and rate-limited outcomes,
  `modelCooldownFromOutcome`, the `video` operation kind and the wait reason
  `accepted_authority_unavailable` are added.
- **Rolling posture.** New owner-only trigger functions live in
  `opengeni_subscription_internal`. The previous release's posture check
  passes against the migrated schema before and after role provisioning.
  The receipt reader is granted to every configured application role (not
  only `opengeni_app`), because the restrictive policies call it for every
  role they bind.
- **Inventory.** The report also counts, per provider and organization,
  switch rows (`inventory:switch_rows_without_receipt`) and core connections
  (`inventory:connections_without_receipt`) of a provider without a receipt
  at the time of 0712, so an operator sees them without a row-security
  bypass.
- **Known gap.** The operator-run lifecycle backfill (0565) reads only the
  legacy credential tables, so Codex connections created between 0689 and
  0712 never get a `model.connected` fact. Extending that backfill to core
  connections is not part of PR 0.

#### PR 0b and PR 0c: the rest of row 0

Row 0 is split into three rolling PRs. PR 0a (above) delivers the receipts
and readiness, the switch-row and connection restrictions, the personal
helpers' receipt, enabled-row, v2, owner and generation checks, the
provider-checked primaries, the operation kinds, the wait reason, the
`model.connected` fact, the adapter interface additions and the
provider-keyed report relation. The remaining items of row 0 and of the
M4-A hand-over are:

- **PR 0b (accepted authority across a cutover):** the compatibility
  relation, reader and copy routines (inert); the server-owned
  `authority_inserted_at` marker on carrier tables; the compatibility-record
  branch of both personal helpers (`connectionIds`); the compatibility
  deferred triggers; fences 0608 and scheduled admission comparing the v2
  slot, the Claude scheduled comparisons and
  `scheduled_claude_authority_changed`; the v1 liveness check switching to
  the core check at the provider's receipt; and the pre-merge inventories
  the plan requires: the functions it patches, the existing rows the new
  Claude comparisons would reject (including live scheduled tasks whose
  Claude snapshots already disagree), resolved before the comparisons go
  live, and the callers of `validate_scheduled_agent_run_live_authority`
  (0447, 0452, 0459 and the scheduled path in `packages/db/src/index.ts`),
  which inherit the `scheduled_claude_authority_changed` refusal.
- **PR 0c (Codex-named administration routines):** the provider-keyed
  cutover planner (the `codex-subscription-core-cutover.ts` rules), the
  auto-assignments table with its apply routine and triggers,
  `record_subscription_codex_plan_change`, the 0702 reach helpers,
  `list_organization_codex_workspace_ids`, and the scope visibility and wake
  routines.

No X1a or C1a call site merges before all three.
#### PR 0c: provider-keyed cutover planner and organization reach

PR 0c is the slice of PR 0 that makes the M3 cutover planner rules and the
organization-reach machinery provider-keyed (everything "Not taken by M4-A"
above except 0691's operation kinds). Rolling migration 0713. Codex
behaviour is unchanged, and every Codex-named routine keeps its name,
signature, owner, grants, security mode, search path and texts for the
binaries that still call it. A later SuperGrok or Claude cutover calls these
with its provider as data and needs no routine of its own:

| Need | Provider-keyed entry point | Codex entry point kept |
| --- | --- | --- |
| Cutover plan | `planSubscriptionCoreCutover(rules, input)` with `SubscriptionCutoverRules` (`packages/db/src/subscription-core/cutover-plan.ts`) | `planCodexCutover(input)`: the same call with `CODEX_CUTOVER_RULES` |
| Reach rows for workspaces created later | `opengeni_private.subscription_core_auto_assignments` (owner-only, with `provider`) | renamed in place from `subscription_codex_auto_assignments` |
| Applying reach to a new shared or Personal workspace | `opengeni_subscription_internal.apply_subscription_core_auto_assignments(provider, account, workspace, personal)`, run by provider-free triggers | `opengeni_private.apply_subscription_codex_auto_assignments` delegates with `codex` |
| Plan-change history | registry flag `records_plan_change`; trigger function `opengeni_subscription_internal.record_subscription_core_plan_change()` | `record_subscription_codex_plan_change()` kept, detached |
| Reading and setting reach | `opengeni_private.subscription_core_reach(provider, account, connection)`, `opengeni_private.set_subscription_core_reach(provider, account, connection, shared, personal)` | the 0702 pair, its own checks first, then the neutral routine |
| Organization workspace inventory | `list_organization_subscription_workspace_ids(account)` | `list_organization_codex_workspace_ids` unchanged |
| Capacity wake | `wakeSubscriptionCoreCapacityWaiters(db, provider, input, enqueue)` (`subscription-core/waiters.ts`) | `wakeSubscriptionCoreCodexCapacityWaiters` wraps it |
| Access editor | `getSubscriptionCoreModelConnectionAccess` / `updateSubscriptionCoreModelConnectionAccess(db, provider, ...)` | the Codex pair wraps them |

Decisions, each the strictest fail-closed reading of the plan and contract:

- **Planner rules as data.** The neutral module holds dedupe and the
  canonical choice (`compareSubscriptionCutoverSources`), the scope choice
  (`organization` only for a single organization source with a NULL
  allowlist, Personal admission and the union policy; otherwise `workspaces`
  over every reached workspace plus an auto-assignment row), one policy per
  (workspace, inference pool) source, the delegated manager and the policy
  union (`unionSubscriptionCutoverPolicies`). A provider supplies
  `SubscriptionCutoverRules`: `statusRank` (the legacy statuses it can
  represent, by canonical preference), `source(row)` (the neutral facts of
  one legacy row, passed through without defaulting) and an optional
  `groupConflict(rows)` naming a merge it must refuse (Codex:
  `fedramp_mismatch`). The rules never read a provider id; the provider's
  own row travels through the plan untouched (`canonical`, `members`) for
  its stage to write. `codex-subscription-core-cutover.ts` keeps only the
  legacy Codex row decoding, the FedRAMP refusal and the quota and
  provider-state mapping.
- **Codex's plan is byte-for-byte unchanged.** 0689 still runs on fresh
  installs and one-window upgrades. The existing plan tests run unchanged,
  and an equivalence test compares the serialized plan with a frozen copy of
  the 0689 planner (`packages/db/test/fixtures/codex-cutover-planner-frozen.ts`)
  over 20,000 generated scenarios in which every conflict class and
  disposition occurs at least 40 times. A synthetic second provider (its own
  row shape, a fourth status and its own merge refusal) plans through the
  same rules.
- **Defect fixed in earlier merged work (0689 planner).** It tested a legacy
  status with `in` against a plain object, so a status named like an
  inherited object member (`toString`, `constructor`) passed and the stage
  then hit the core's status CHECK, aborting 0689 on a constraint error. The
  neutral rules read own keys only and report `unrepresentable_status`, which
  aborts the cutover with a content-free conflict instead. Only the reason
  for that abort changes; every other input plans exactly as before.
- **Reach rows renamed in place, keyed by provider.** The table keeps its
  rows, owner-only grants and RLS mode and gains `provider` (every existing
  row is Codex's, written by 0689's cutover or 0702's helper). Two keys
  replace 0689's `(account_id, connection_id)` key: `provider` references
  the registry, and `(account_id, provider, connection_id)` references the
  connection's `(account_id, provider, id)` with `ON DELETE CASCADE`. A row
  therefore carries its own connection's provider, a row of an unregistered
  provider cannot exist, and any other existing row would abort the
  migration. There is no compatibility view: runtime roles never read the
  table, and every routine that does is redefined in the same transaction.
  The registry stays untruncatable: a plain TRUNCATE is now refused by the
  reach rows' key, and TRUNCATE ... CASCADE by its append-only guard.
  PostgreSQL's initial validation of a new foreign key runs as the table
  owner without exempting it from FORCE ROW LEVEL SECURITY, so it would see
  no connection rows and report a false violation; an owner-only NO FORCE
  window wraps that one statement (`check:migration-rls-backfills`).
- **One apply path.** 0689's apply body with the provider as data, in
  `opengeni_subscription_internal` (owner-only routines stay out of
  `opengeni_private`, whose unknown routines a previous binary's readiness
  rejects). Its writes are admitted by two owner-only policies keyed on the
  provider-free setting `opengeni.subscription_core_auto_assign`, one for
  one with 0689's Codex policies, which stay, unused, until retirement. The
  provider-free triggers `workspaces_subscription_core_auto_assign` and
  `organization_memberships_subscription_core_auto_assign` replace 0689's
  two Codex triggers on the same events, sort into the same place among each
  table's triggers, and apply the reach of every provider with rows in the
  organization, in provider order. 0689's trigger functions stay, detached.
- **Plan-change history by registry flag.** `records_plan_change` (true only
  for Codex) replaces the provider test. The provider-free `BEFORE UPDATE OF
  plan_type` trigger `subscription_connections_core_plan_change_trg`
  replaces 0689's; its function is `SECURITY DEFINER` (0689's was invoker)
  because the registry is owner data, and it only edits `NEW`. Codex records
  the same keys as before.
- **Organization reach.** The neutral pair is 0702's helpers with the
  provider as data: runtime-callable `SECURITY DEFINER` routines (search path
  `pg_catalog`, data schema, `opengeni_private`, `pg_temp` last) granted to
  the application roles only. Checks run in a fixed order: organization
  administrator (42501), reach given as a pair (setter, 22023), a provider
  registered on the shared core (22023, even where no row could exist), then
  the provider's own organization-managed shared subscription connection
  (P0002). Each provider sees only its own rows. The Codex-named pair keeps
  its texts and checks, then calls the neutral routine on the same rows. The
  shared core's organization allocator switch and the access editor call
  the neutral pair with the binding's provider, so M4-A's optional
  `organizationAllocatorChanged` binding hook, which existed only to reach
  the Codex routine, is removed.
- **Inventory and wake.** `list_organization_subscription_workspace_ids` is
  0422's content-free inventory (shared and Personal workspaces, organization
  context only) under a provider-free name, granted to the application roles
  and listed with the runtime posture's organization lifecycle routines. The
  shared capacity wake takes the provider and the session workflow wake
  producer as arguments (the producer lives in the package index, which
  shared modules do not import) and wakes only while that provider's cutover
  is enabled. The shared core's wake and organization paths depend on no
  Codex scope-visibility helper: `codex_organization_scope_visible` and
  `codex_organization_admin_visible` are called only by legacy factory-table
  policies, 0424's access guards on the API-key connection tables and 0492's
  legacy Codex source check, all left as they are.
- **Rolling posture.** On a provisioned database without 0713, the previous
  release's evaluator, run as the runtime role, reports nothing missing
  before 0713, after it and after provisioning again; the new evaluator
  reports exactly the seven new routines before 0713 and nothing after it.
  The migration grants the three runtime routines to the application roles,
  PUBLIC holds none of the seven, and provisioning again leaves those grants
  as the migration set them.
- **Kept until retirement.** The Codex-named reach pair, apply routine and
  detached trigger functions (`auto_assign_subscription_codex_workspace`,
  `auto_assign_subscription_codex_personal_workspace`,
  `record_subscription_codex_plan_change`) and 0689's `*_codex_auto_assign`
  policies are dropped with the other Codex-named routines (§5.1.2, "Rolling
  compatibility and retirement"). `list_organization_codex_workspace_ids`
  stays while the legacy SuperGrok and Claude organization wakes call it
  (until X4 and C4).
- **Migration tests.** Tests that withhold 0689 also withhold 0713, which
  renames objects 0689 creates, and replay it after 0689; the neutral-routine
  test replays 0707 and 0713 together.

#### Verification plan

- `bun install`; adapter conformance per provider without network (scripted
  upstreams for sign-in, refresh, usage, streams, refusals, malformed
  responses, delays and connection loss) with a network-denial guard; the
  fake API-key adapter runs the same suite.
- Placement compared with the reference model on generated worlds with both
  providers, compatibility narrowing, per-model cooldowns and non-renewable
  credentials.
- Migration tests on real PostgreSQL as the non-superuser, non-bypass
  `opengeni_app` role with an owner-migrated harness and 180 000 ms budgets:
  every scope and owner shape; duplicates (one person across workspaces,
  different people, setup token and OAuth of one person, unknown ids);
  secrets; aliases; pins (manual unhealthy, personal ineligible, other
  provider); live leases; waiters with pending wakes; compatibility records
  for every carrier kind and v1 shape; video and image ledgers. Assert exact
  report parity, rollback on each abort class and FORCE-RLS blind-spot
  probes; existing Codex rows and v2 values byte-for-byte unchanged; the
  other provider's legacy rows untouched; both window plans, and a Claude
  abort leaving SuperGrok cut over.
- Compatibility copy paths: for each path in "Accepted authority across the
  cutover", a source created before the cutover (including a terminal
  execution-context turn, a session with no turns, a child's parent turn, a
  scheduled revision and an outbox row) yields, after the cutover, a receiver
  with the identical record; this is the
  `compat:dependent_sources_without_record` test. A source without a record
  waits with `accepted_authority_unavailable`.
- Request custody per provider: one `model` row per physical request
  (including xAI hosted-search continuations and title requests), typed
  refusals settle as known outcomes, an unknown outcome is never replayed.
- Idle sources after the cutover: an Agent message and a child result
  delivered into a session that was idle at the cutover, a goal continuation
  after idle, a child session spawned before the cutover with no turn yet,
  and a scheduled-task update's Claude custom-model admission use the
  resolver's record; a source without one waits and then fails with the
  typed failure. Per path, a real-PostgreSQL test where the sender's and the
  receiver's records differ, and one where another human causes work from a
  `user` source (no record, shared capacity, no wait).
- Generations: one owner with `user` credentials in two workspaces plus a
  Personal-workspace credential ends with exactly one current generation per
  provider; a workspace-A record does not reach the owner's workspace-B
  connection in either SQL helper; post-cutover acceptance writes a non-empty
  personal v2 entry.
- v1 fences: scheduled tasks created before the cutover on Codex, Claude and
  xAI models admit occurrences after X3, X4, C3 and C4; an inbox batch is
  delivered into a pre-cutover execution context after each step; PR 0's
  Claude comparisons reject a mismatched run, occurrence and generated
  session, and a revoked Claude user authority returns
  `scheduled_claude_authority_changed`.
- Record writes: the app role cannot insert, update or delete records; a
  derived carrier committed without its record, or with a different one, is
  rejected at commit by the deferred trigger; a source the cutover missed
  yields a waiting `{personal: [], shared_pool: none}` copy;
  `authority_inserted_at` cannot be supplied or changed (a carrier derived
  from a missed source commits only with the `missing` copy, and an explicit
  `created_at` from an older binary is still accepted); a mixed inbox batch
  of a narrowed pre-cutover update and an unnarrowed post-cutover update is
  split, and so is a batch of a missed pre-receipt update and a post-receipt
  update that both have no record.
- Grants: after the cutover and a fresh `provision-roles`, runtime roles hold
  no write grant on the provider's legacy tables (posture contract).
- Lifecycle facts: a core connect emits one `model.connected` fact with the
  provider; the cutover's own inserts do not.
- Authorization tests as `opengeni_app`: shared, private and Personal
  sessions; ownerless sessions never reach personal or people-scoped rows;
  service and non-human acceptance gain no personal authority; compatibility
  records cannot be written or altered by the app role and are only copied
  from the exact causal source; switch rows cannot be enabled before a
  receipt; delegated managers; aliases; organization boundaries.
- Temporal: replay existing SuperGrok and Claude capacity-wait histories (with
  `provider` recorded and pre-provider-tagged), signal-before-peek,
  peek-before-signal, continue-as-new, and the cutover seam where the legacy
  peek completed before migration and reconciliation runs after it against
  the preserved waiter id and generation.
- Crash injection around commit, lease transfer, wake commit before signal,
  refresh persistence, image dispatch and video reconciliation.
- Static guards, focused package, API and worker suites, migration guards and
  release-schema registration at all three sites.

#### Decisions

1. v1 accepted authority stays authoritative for a provider until that
   provider's own drained cutover commits; before it, no M4 path reads v2 or
   compatibility records for that provider.
2. Ownerless sessions are shared-only (organization- or workspace-scoped
   connections) for both providers on placement, renewal, dispatch, refresh
   and waiter recovery; ownerless bindings stay denied.
3. Personal connections serve only the owner's private sessions or Personal
   workspace, with exact owner membership and a current authority generation,
   as §3.8 enforces. An explicit selection by the owner does not widen this in
   M4. Transcription and realtime never use personal connections (behaviour
   change: legacy preferred the caller's personal SuperGrok pool).
4. Background work keeps its accepted pool: compatibility records narrow
   shared candidates to the legacy pool and pin personal authority to exact
   connections, and continuations copy them without widening. Pre-cutover
   `user`-pool work in a shared session, or whose authority cannot be carried,
   waits with `accepted_authority_unavailable` instead of moving to shared
   capacity; the wait ends at the capacity-wait deadline with a typed failure
   the owner sees, whose remedy is to send the work again, and the parity
   report counts the affected carriers before the window.
5. A user-scoped credential becomes a personal connection usable in the
   owner's private sessions in any workspace that allows personal connections
   (reach widens for the owner only; release note). Each owner gets one fresh
   generation per provider at the cutover, above every earlier generation of
   that membership; pre-cutover work keeps personal access only when the
   legacy authority was active at the snapshot's generation, and only to the
   exact connections its record lists.
6. Video, image, transcription and realtime never write the chat binding.
   Video reconciliation without a usable connection ends at its recovery
   deadline rather than refreshing outside the core lock.
7. Claude 403 does not rotate accounts and 529 stays in the overload lane, as
   today.
8. The cutovers are explicitly ordered and data-independent (above).

#### Findings in earlier merged work

| Finding | Where | Fixed in |
| --- | --- | --- |
| Runtime roles acting as an organization administrator can insert or enable `subscription_provider_cutovers` rows for `xai` and `claude`, and insert their core connections, before any drained move. Inert in runtime code today (every reader passes `codex`), but the SQL placement helper (0667) and 0668's non-Codex branch already accept any provider and would act on such rows as soon as an X1a or C1a call site exists; 0668's branch also compares a legacy generation with a core one. Such rows would also abort the cutover preflight. | 0642 connection insert policy; 0689 cutover administrator policies; 0667; 0668 | PR 0, merged before any X1a or C1a call site; runbook inventory query |
| §3.7 says the 0608 inbox fence compares Codex against v2, but no later migration redefines `fence_inbox_execution_context`, so receiver-context turns are not fenced on `subscription_authority` in SQL. Scheduled admission and occurrence functions do not compare v2 either; the 0688 revision trigger only fills a NULL revision value. Both need a v2 comparison. | 0608, 0275, 0478, 0688 | PR 0 |
| §3.7 says Claude stays compared against its v1 columns, but scheduled admission (`admit_scheduled_agent_run_execution`, restated by 0478 with the 0416 and 0447 changes and patched in place by 0501; `validate_scheduled_occurrence_accepted_execution`; `validate_scheduled_agent_run_live_authority`; the occurrence and turn-execution fences) never compares Claude: not the run's accepted Claude snapshot, the occurrence update, nor the generated session's `initial_claude`, and there is no Claude equivalent of `scheduled_xai_authority_changed`. Claude scheduled pools are fenced only in TypeScript. | 0275, 0416, 0447, 0478, 0501 | PR 0 |
| The `{codex,claude,xai}_primary_connection_id` foreign keys omit `provider`, so a primary can reference another provider's connection. | 0642 `subscription_settings` | PR 0, or M4-A's settings shape |
| The non-Codex branch of `authorize_subscription_personal_access` compares the owner subject but neither requires the connection's owner membership id to equal the session owner's membership nor checks `personalConnectionsAllowed`. | 0668 | PR 0 |
| `autoRenews` is a static adapter flag but is documented as false for setup tokens. | `packages/subscriptions/src/adapter.ts` | PR 0 |
| EP-N13 (organization-scope video envelope rejected) and EP-N14 (direct refresh outside the lock) are still present. | `video-generation-credential.ts`, `video-generation-reconciliation.ts` | X2a |
| The M3 Codex cutover kept each verified `user` row's legacy generation and gave Personal-workspace rows generation 1 (`codex-subscription-core-cutover.ts`, 0689), the ambiguity "Personal authority generations" avoids. An owner left with more than one current Codex generation gets an empty personal v2 entry on every new acceptance (0669, 0688), silently losing personal Codex access; the 0688 connect writer assumes one generation. | `codex-subscription-core-cutover.ts`, 0669, 0688, 0689 | PR 0 adds the count (owners whose active, serviceable personal Codex connections carry more than one current generation) to the readiness report and runbook. The repair, one fresh generation per affected owner as in M4, is an owner decision (open question), because older frozen v2 entries then lose personal reach. |
| The `model.connected` lifecycle fact is emitted only by triggers on the legacy credential tables, so Codex connects stopped producing it after the 0689 cutover. | 0565, 0598, 0602 triggers | PR 0 (provider-keyed fact on core connection insert) |
| Resolved since the inventory baseline: its open question on 0263 lacking `claude_subscription` (correct at `0d7075e`) no longer applies, because 0642 added `claude_subscription` and `subscription_connection` to the retention function. The inventory is a baseline record and is not edited. | inventory §4.2.4 | nothing to fix |

Open questions for the product owner: whether owners may later choose their
personal account in a shared session (an M5 widening this plan does not
make); whether anyone depends on personal-only SuperGrok transcription or
realtime, which decision 3 removes; and whether to repair Codex owners with
several current generations (finding above) if the count is not zero.

## 6. Specific behaviours

### 6.1 Cache coldness (SUB-STICK-04)

Claude: idle longer than the TTL Opengeni sent. Codex and SuperGrok: a
per-provider cut-off measured from `model_call_facts`, which gains
`connection_id` (also needed for SUB-ACCT-01). Until measured, the cut-off is
60 minutes: erring towards "warm" avoids paying a cache miss for a switch
that was not needed, at the cost of returning to the preferred account later.

### 6.2 Events (SUB-FAIL-06)

`subscription.account.switched { provider, fromConnectionId, toConnectionId,
fromModel, toModel, reason }` with reason in `initial`, `reselected_cold`,
`failover_same_provider`, `failover_cross_provider`, `return_to_preferred`,
`explicit_choice`, `revoked`; and `subscription.capacity.waiting { reason,
earliestResetAt }`. Existing Codex account-switch events remain as aliases
for current clients (SUB-COMPAT-02).

### 6.3 Codex Apps and reset credits (SUB-APPS-01, SUB-APPS-02)

Apps credentials load by their designation, never through placement. Any
organization administrator or the connection's delegated manager may
designate or clear Apps in any routing mode. Reset-credit redemption stays
human-only from a browser session, allowed to organization administrators
and delegated managers of that connection (not "whoever connected it").

### 6.4 Compaction (SUB-FAIL-09)

Remote compaction keeps only an opaque encrypted item plus retained user,
system and developer messages, so there is no cleartext to convert at
failover time. Therefore: new sessions whose model has an effective
cross-provider fallback start with portable compaction; existing
remote-compaction sessions convert at their next compaction while Codex has
capacity; until converted they fail over only within Codex and otherwise
wait with an explained reason.

### 6.5 Consumers outside chat (SUB-FAIL-10, SUB-CONS-01)

Transcription, realtime, image and video place an account per operation
through the same eligibility and authority rules, take a lease, and never
fail over across providers in the first release.

## 7. Verification

- Reference-model conformance on generated worlds and scripted scenarios.
- No-network provider conformance for each adapter (refresh, usage, streams,
  refusals, malformed data, delays, connection loss, partial streams,
  entitlement failures); unexpected network access fails the test.
- Migration tests on real PostgreSQL with the restricted role: per-provider
  parity with explicit account context, dedupe and aliases, live waiter
  carry-over, forward-only recovery.
- Workflow replay of existing capacity-wait histories across M3 and M4.
- SQL and TypeScript effective-settings/`inference_source` parity, including
  automatic admission of both shared pools, primary/local exhaustion falling
  through to organization capacity, workspace-only and organization-only
  filtering, disabled projection, and source transitions without changing
  Apps authorization. A Personal-workspace owner with a migrated personal
  connection must use healthy shared organization capacity before personal
  fallback; exercise the same upstream identity present in both legacy pools
  with different per-pool model policies.
- Snapshot migration tests prove legacy source/policy is retained as
  secret-safe provenance, manual explicit choice is represented only by the
  binding, and live shared eligibility/source/pin changes govern the next
  placement and dispatch after cutover.
- Compatibility tests prove M3 adds Codex v2 authority without changing xAI or
  Claude v1 snapshot bytes or breaking their existing accepted-authority
  readers or 0608/0275/0478 admission-fence comparisons. Ownerless service
  sessions can use shared connections but cannot observe or acquire personal
  connections. Personal-workspace fallback needs both the migrated owner
  opt-in and effective setting, with organization locks preserved.
  Resource-generation transfer preserves valid queued authority while a
  revoked/stale resource never regains personal access.
- The contract's mutation gate.

## 8. Risks

- Concurrent changes in this area: M1 and M2 change no behaviour and land
  first; each cutover is one provider at a time.
- Cutover migrations are maintenance-mode and one-way; they need drained
  workers and a tested forward-fix path.
- Dedupe of duplicated upstream accounts can change which account a session
  lands on; bindings are remapped through aliases.

## 9. Review changes

Revision 1 was reviewed independently on 2026-10-07. Accepted changes:
mirror-trigger dual write removed in favour of shadow-on-legacy and one-time
moves (secret in one place, no FORCE-RLS write failures, no loops); owner
window and parity with account context for backfills; Personal-workspace
accounts become personal connections; Codex modes expressed as per-workspace
provider settings; Apps designation and redemption rules; canonical lock
order and hash spread; explicit choice only on the binding and per-provider
personal authority; people scope keyed by session owner; delegated managers
cannot change scope; membership lifecycle kind; between-call mid-turn
failover with funding re-check and history filtering; portable-compaction
default instead of conversion at failover; account dedupe; turn failure
receipts and bound; entitlement column and refresh generation; model-call
timestamps and `connection_id` on call facts; faithful rotation mapping;
security-parity shadow; reference-model fixes.

### Catalog observations and selection corrections (2026-10-09)

Migration 0695 stores successful Codex model-catalog observations beside quota
with an independent credential generation and 60-second expiry. It stores raw
upstream model ids, not the active picker list. The accepted turn’s immutable
product-to-upstream mapping determines its entitlement, preserving retained
models after retirement. Missing or failed reads remain unknown; stale or
superseded observations do not restrict placement. Legacy turns without a frozen
mapping remain unknown rather than guessing their upstream identity.

The shared operation credential gate authorizes observation writes. Every core
chat placement, waiter evaluation and extra-credit admission reads the same
facts; no process-local catalog state is authoritative. Catalog expiry supplies
a retry deadline. Quota updates preserve catalog facts, and catalog writes
preserve quota, model cooldowns and administrator exclusions. No image, Live,
transcription or Apps capability is inferred from the chat-model catalog.

Own-Personal automatic use remains subject to live personal-connections policy
and accepted personal authority. Unknown quota has no ranking penalty. The
independent reference model includes Codex credit consent, refusal deadlines,
included-capacity preference and explicit-pin behavior.
