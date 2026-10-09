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
  managers can reconnect, rename and toggle allocation; only organization
  administrators change scope, ownership, or delete (SUB-OWN-04).
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
   is known), then by known capacity before unknown, then by a deterministic
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
  `list_organization_codex_workspace_ids` and writes in the trusted
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
  or all (PR 3).

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

Migration 0676 (rolling) and the matching code complete every Codex writer on
the core before the drained cutover, so the cutover moves data and flips no
route to a 409. Like PR 1/2 everything is dormant: no cutover row keeps the
legacy path unchanged, a disabled row fails closed (typed 503), and every
database routine below rechecks the enabled row itself.

- **Connect and disconnect (SUB-OWN-01/04/08).** The device-code start
  touches no state and runs unchanged (a disabled cutover still fails
  closed). Poll writes through `connectSubscriptionCoreCodexConnection`:
  - a new shared connection is an organization decision: only an
    organization administrator creates one. From the organization route it
    is organization-scoped and organization-managed; from a shared
    workspace's route it serves and is managed by that workspace (exactly
    the core shape the drained cutover gives a legacy workspace account),
    with its assignment and pool policy;
  - the same upstream account reconnects in place: a new credential, the next
    refresh generation, active status. An organization administrator may
    reconnect any shared connection, a workspace administrator only one their
    workspace manages (the core update policy); an account connected and
    managed elsewhere is never widened or taken over (`managed_elsewhere`,
    409). SUB-OWN-08 holds by construction: one connection per organization,
    provider account and owner;
  - in the person's own Personal workspace, connect creates or reconnects
    their personal connection through the owner-scoped writer
    `connect_subscription_codex_personal`, only with personal connections
    allowed there (SUB-OWN-05). A new personal connection carries a
    `subscription_connection` resource authority with the owner's one current
    generation for personal Codex connections (1 for the first), so frozen
    accepted authority keeps resolving to a single generation.
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
  chat or operation lease still names it (leases are `RESTRICT`; a stale
  lease is not cleared here because its session's restrictive visibility
  policy applies to the routine too). Disconnect-all removes every account
  the workspace manages (or the person's personal connections) atomically.
  An organization account named from a workspace route keeps the legacy 409.
- **Personal connections in their owner's views.** The owner-only reader
  `subscription_codex_personal_connections` returns the acting person's own
  personal Codex connections (no credential material) for a workspace they
  may use. Their Personal-workspace account list includes them (never an
  Apps designation target: designations are shared-only), and a session
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
  idempotency key.
- **v2 writers at acceptance (design 3.7, EP-T13..T15).** Values are copied,
  never recomputed from current membership; non-human acceptance freezes
  the empty value; nothing is written before the cutover:
  - scheduled tasks freeze their value once at creation
    (`subscription_codex_task_authority_v2`, the acceptance rule: a personal
    entry only for the exact requesting person in their own Personal
    workspace, or a reusable session's acceptance value). Revision
    authorities derive theirs from the task by trigger (the empty value when
    anyone but the owner authorized the revision). A firing copies the
    task's value onto its first turn or its scheduled occurrence, narrowed to
    the empty value when the accepted revision's authorizer is not the owner;
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

### 5.2 Legacy shape mapping

| Legacy | New |
| --- | --- |
| Workspace-scoped credential in a shared workspace | Shared connection scoped to that workspace, managed by it. |
| Workspace-scoped credential in a Personal workspace | Personal connection owned by that workspace's owner. Set the owner's `personal_fallback_opt_in` and the effective workspace `personal_fallback_allowed` override (D-18); otherwise opt-in alone cannot reach the fallback candidate. An explicit organization lock of `false` remains authoritative and is recorded as a non-parity disposition, never overridden. |
| Organization credential with `allowed_workspace_ids` / `allow_personal_workspaces` | Shared connection: `organization` scope when the list is NULL, otherwise `workspaces` scope with the same list. |
| User-scoped credential (xAI, Claude) | Remains on its existing provider-specific v1 path through M3; M4/M6 map it to a personal connection for the same membership and add that provider's v2 authority entry. |
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
