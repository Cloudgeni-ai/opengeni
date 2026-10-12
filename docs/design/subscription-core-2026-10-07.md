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
5. **The account belongs to the session.** One chat binding per session and
   provider (D-32 of the contract, migration 0733). Explicit choice lives only
   on the binding, never in frozen turn authority.
6. **Accepted work freezes only personal authority**, per provider. Shared
   eligibility is checked live.
7. **Spread is a deterministic hash** of the session id over eligible accounts
   (D-21). No cross-session lock is needed (SUB-SEL-05).
8. **Cross-provider failover requires portable compaction.** New sessions use
   portable compaction whenever a cross-provider fallback is in effect for
   their model; existing Codex remote-compaction sessions convert at their
   next compaction while Codex still has capacity, or at failover by
   reconstructing and summarizing all retained cleartext work units on an
   authorized target. Original durable history and compaction records stay
   intact. Unsupported or incomplete reconstruction fails closed with an
   actionable reason (D-40, §5.7.5; Q-05 resolved within implementation scope).

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
with a static credential, no refresh and no provider quota windows (a spend
budget or a rate limit is recorded in the shared quota model, §5.3). They are
stored as
connections with `kind = api_key` in the same table, which makes them
failover targets and gives non-agent consumers one way to obtain a model
credential. Moving the existing API-key connection tables is a separate,
later step. How one plugs into the shared core without core changes (what
it implements, what it stores, what the core does) is in §5.3, "API-key
connectors on the shared core"; a test-only connector proves it.

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

Merging (`applyQuotaObservation`) depends on `source`. A usage-endpoint
reading of an adapter that declares its usage readings complete
(`usageReadingsComplete`) replaces the stored windows outright, so it can
show an early reset (a reading that omits an exhausted window ends that
window's block); an adapter declares it only when its usage endpoint reports
every window the provider tracks. Response-header readings, refusals and
every other adapter's usage readings (fail closed: absent means partial,
Claude's are partial) report only some windows: a stored exhausted window
with a known future reset that such an observation does not report stays
until that reset (one that reports the window again replaces it). Whatever
the source, a running `exhaustedUntil` deadline or model cooldown is never
shortened, and an older or undated reading never replaces a newer dated one.
So a writer's own refusal is tagged `refusal`, never `usage_endpoint`.

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
- Locks are enforced at write time by migration 0724 and exposed through the
  model-account settings API; see §5.5.

### 3.4 `subscription_session_bindings`

Primary key `(workspace_id, session_id, provider)`: `connection_id`,
`model_id`, `choice` (`automatic` | `explicit`), `only_this_model`,
`last_model_call_at`, `last_switch_reason`, `version`.

- A session keeps one binding per provider (D-32): each provider's explicit
  choice or automatic placement for that provider's models, as each provider
  kept its own pin before the shared core. Placement, requests, pins and the
  cache clock read and write only the row of their own provider, and a row
  never changes provider (trigger `subscription_session_bindings_provider_fixed`,
  which a drained cutover keeps enabled while it disables the table's other
  triggers, or verifies afterwards that no pre-existing row changed provider).
- The neutral session-choice API infers the provider from the chosen connection
  and changes only its row. Its additive `bindings` response lists every provider's
  choice, withholding connection ids the caller cannot see; the original `binding`
  field is the sole binding when there is exactly one, otherwise null. Returning
  to automatic with `provider` changes only that provider's explicit choice;
  omitting it keeps the original whole-session meaning and resets all explicit
  choices. The change records one event and wakes only the affected providers.
- Rolling window: migration `0733_subscription_session_bindings_per_provider.sql`
  moved the key from `(workspace_id, session_id)` and keeps a unique index
  `subscription_session_bindings_rolling_session_idx` on those two columns,
  because the previous binary upserts with that conflict target. While it
  exists a session still holds at most one row, so the previous binary always
  reads the session's only row and can never meet a second provider's. The
  next drained provider cutover (SuperGrok's) drops it after its preflight has
  refused every other runtime login and before it writes any binding of its
  own (its inserts would otherwise hit the index on sessions with a Codex
  row). The drop is safe only once no previous binary can run at all, so that
  preflight refusal stays in force until the previous image can no longer
  start: without the index only the previous upsert fails (42P10), while the
  previous binary's binding reads and its Codex pin's UPDATE by
  `(workspace_id, session_id, version)` carry no provider and would read or
  rewrite another provider's row. While the index exists, two concurrent
  first bindings of one session can meet it as a unique violation instead of
  the conflict target; placement retries that as a lost compare-and-swap and a
  pin reports it as unchanged.

- `last_model_call_at` is the session's cache clock (M5 cache-aware
  stickiness, D-30 and D-31 of the contract). It advances, forward only and
  only while the binding still names that connection, when a placement
  commits on the bound account and when a model request on it is reserved
  (in the reservation's transaction), so a long turn is not mistaken for a
  cold cache. For an adapter that declares an idle cut-off it also advances
  when a model call completes; an exact lifetime is refreshed when a request
  starts, so for it the end of a call is not recorded. A clock-only advance does not bump
  `version`. A switch of account or model writes the placement time as the new
  clock; the trigger `subscription_session_bindings_cache_clock` (migration
  `0723_subscription_binding_cache_clock.sql`) clears it for any writer that
  changes the connection, provider, model or choice without stating a clock,
  so a pin change or an older binary never carries warmth to another account.
  Setting or removing a pin therefore makes the next turn re-run selection
  (D-31): a request, a completed call or a retried attempt that keeps its
  lease never restarts a cleared clock, only a new selection at placement
  does, so removing a pin mid-turn still takes effect at the next turn. A
  compaction is a re-selection point only when it is later than the clock.
- Placement reads the binding under its row lock (`FOR UPDATE`, in the
  placement world, before the lease) and decides and commits from that row,
  so no pin or other placement of the session changes it in between; only
  the first binding of a session (no row to lock yet) can race, and the
  insert's compare-and-swap makes the loser retry. A model request's
  reservation locks the same row before the account's request lock and
  advances the clock under it. Every path that holds both takes the binding
  row first and the per-connection lock (`subscription-refresh:<connection>`,
  taken by the lease, request and binding admission triggers) second, as a
  person's pin does, so a pin of the account a session is on never deadlocks
  with that session's requests or placement. The clock is application time,
  as placement judges warmth by it.
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

#### Owner decision: explicit personal choice in a shared chat (2026-10-12)

The private-work rule above remains the meaning of existing v2 entries and
compatibility records. Its only new exception is an authenticated participant
explicitly choosing **their own** personal account in a shared session, subject
to live organization/workspace personal-account policy. The participant need
not be the session creator. Shared `people` scopes still mean the session
owner; do not substitute the choosing person for the session identity.

Fresh human acceptance can add `sharedSessionChoice: { sessionId, connectionId }`
to that provider's v2 entry. Both UUIDs are required, canonical and strictly
validated; unknown fields and malformed restrictions fail closed. The entry
still carries the account owner's membership and exact resource generation.
The authenticated accepting human must own the explicit provider binding's
connection and participate in the session. A service, API key, ownerless
context, automatic binding or different sender grants no such entry. No
creator fallback is available for this new branch. Existing private entries
and compatibility `connectionIds` keep their original interpretation.

Readers must support the restricted shape before any writer emits it. This
is not a rolling-writer-compatible extension: old strict readers reject the
extra field. Activation uses the established drained-maintenance upgrade and
transaction-local runtime protocol receipt, not a parallel feature gate.
The migration rejects live configured runtime database sessions; restricted
acceptance rejects a missing receipt and restricted spending fails closed.
Pre-upgrade binaries may not restart after activation. No backfill,
generation rotation or rewriting of already accepted work is permitted.
SQL access and placement consume the stored exact restriction, never a live
binding as a substitute for consent. Live account-owner membership, workspace
participation, resource generation, effective policy, provider receipt and
cutover checks remain mandatory. The genuine session owner and initiating
human remain separate fields in every runtime capability.

Background, replay, recovery, schedules and causal copies retain the original
entry verbatim. It cannot authorize a different session or a same-generation
sibling connection. A later choice affects only the next acceptance unless
the waiting turn's frozen authority already admits the exact target under
live checks; the choice response must not claim `waiting_turn` otherwise.
Shared visibility never activates automatic personal fallback. Administered
credential/version/refresh/quota routes remain exact-owner Personal-workspace
only: an inference capability does not open them.

The forward implementation preserves 0716 receipt/compatibility gates, 0717
immutability and copy fences, 0726 lifecycle marker bracketing and 0728
inserted-now replay protection. Provider-qualified binding keys, placement
commits and cache clocks remain the independent 0733 contract. Real PostgreSQL
verification must run as a non-owner, non-superuser, non-BYPASSRLS application
role and include a non-superuser owner-migrated database.

## 4. Placement

One transaction per placement. No provider call happens inside it. It reads
the session and the turn without row locks, then locks the session binding
row (`FOR UPDATE`) and decides and commits from that row. A session's first
binding has no row to lock yet: its insert's compare-and-swap makes a
concurrent loser retry. Placement and model requests lock the binding row
before the per-connection advisory lock (`subscription-refresh:<connection>`)
and the lease, as a person's pin does (D-31 of the contract): the lease
triggers and a request's reservation take that lock after the binding, so a
pin of the account a session is on never deadlocks with the session's
placement or requests. Turn rows are locked only in shared modes on these
paths (`FOR KEY SHARE` by the lease triggers, `FOR SHARE` by a request's
reservation), which never block one another.

1. Read effective settings (SQL).
2. If the binding is `explicit`, use that connection or wait
   (`pinned_account_unavailable`); a choice that can never serve the work
   waits as `pinned_account_ineligible` (D-24), including this provider's
   choice of a deleted account (its reference cleared by the foreign key).
   The binding read is this provider's own (D-32 of the contract): another
   provider's pin is never read, written or cleared, so its account, clock
   and version stay as stored and switching back to that provider's model
   uses the pinned account.
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
§5.7 designs the cross-provider step and the mid-turn switch in detail.

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
| M5 | Product features: scopes and people, personal connections for every provider, settings with overrides and the overview, cache-aware stickiness (6.1, 3.4; migration `0723_subscription_binding_cache_clock.sql`), cross-provider failover (5.7) and portable-compaction defaults. API and UI, previewed before merge. | rolling | product |
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
   `subscription_session_bindings` row per provider (D-32). A manual pin is `explicit`; otherwise
   preserve the latest effective selected account as `automatic`. Resolve ids
   through aliases, keep each row's provider, and set
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

The retained Codex session-pin endpoint calls the neutral
`chooseSubscriptionCoreSessionAccount` transaction with `provider: "codex"`.
Its compatibility receipt projects the existing event and response inside
that transaction; there is no second binding or event writer. Choosing
Automatic affects only Codex, never a Claude or SuperGrok binding. Repeating
an unchanged choice preserves the legacy acknowledgement event without
incrementing the binding version. The SDK's legacy methods remain available
and point callers to `getSessionModelAccount` / `setSessionModelAccount`;
no route removal or sunset date is introduced.

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
  crash-safe backstop the global dispatcher always delivers. The wake takes
  the canonical workspace, then session, then waiter lock order: per
  workspace, in ascending workspace order and after the tenancy fence, it
  reads the waiters' sessions without locking and, only if there are any,
  key-share-locks the workspace row (as `lockSessionEventWriteRows` does, and
  before a runnable wake or a context clear's `FOR UPDATE` could interleave;
  only a key share, the weakest lock that excludes those `FOR UPDATE`
  lockers: a stronger one would also hold off workspace updates, `FOR SHARE`
  authority checks and concurrent wakes). It then locks those sessions
  `FOR NO KEY UPDATE` in ascending session order (the generic wake's archive
  guard's own mode, so Steer, Cancel and a resume, which lock the session
  before its waiter, cannot interleave), skipping any that no longer exist or
  are archived or imported (whose generic wake the guard would refuse), so
  one such session no longer fails the whole wake. Only for the sessions it
  locked and found executable does it record the generic wake, bump the
  waiters and record their typed wakes. Typed delivery
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
   (keyed by provider since §5.3 PR 0c; its provider-free name comes at
   retirement)
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

`check:no-legacy-codex-runtime` (since X4 an alias of the provider-neutral
`check:no-legacy-subscription-runtime`, below) is also run by
`check:subscription-contract`. It rejects executable legacy table/schema references and imports of historical
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
  per-provider branches that its step must extend. The neutral routines
  manage only connections of the kind the registry row names
  (`connection_kind`, `subscription` or `api_key`, immutable once
  registered; step F, migration 0714), read through the owner-only
  `subscription_core_connection_kind(provider)`, never by a provider branch;
  their Codex twins still accept only `kind = 'subscription'`. A provider's
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
  R's drained migration 0744 drops the 19 twins with the owner-only writer
  context (called by four of them) and connection target. That needs the
  release containing the posture's twin tolerance (#4128) to be the minimum
  running one, which a drained window gives: afterwards only the release
  carrying 0744 starts, and every older release refuses the retired
  database. The drop is one transaction, so a partial drop cannot remain.
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
- `health`: forbidden-quarantine and entitlement-cooldown durations, and
  the fallbacks `rateLimitFallbackMs` and `exhaustedFallbackMs` for a refusal
  that names no time (step F);
- `credential`: `decode`/`encode` of the decrypted plaintext (fixed error
  text, never echoing it), `expiry` (the embedded expiry when the store has
  none) and `format` (PR 0, read with `capabilitiesFor`);
- `refresh`: `CredentialRefresher` (`windowMs`, `fallbackMs`, `rotate`,
  `reloginMessage` classifying a permanent refusal) or `null` for credentials
  that never renew;
- `reloginText(message)`: the stored needs-relogin text.

`credentialKind` decides the connection kind the shared writers,
administration and placement manage (`subscriptionCoreConnectionKind`, step
F). `quotaKind` is a declared fact; `health` is read by the shared settlement
step (step F), which the live Codex worker does not use yet. The core reads `capabilities.extraCredits`: the placement world
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
  exactly as a subscription window does. Step F proves this with a test-only
  connector (§5.3, "API-key connectors on the shared core").

Still Codex-named or missing, and owned by the provider steps (or by the
shared settlement step they share) rather than by this extraction:

- worker settlement (`apps/worker/src/activities/agent-turn/codex-core-settlement.ts`):
  refusal settlement into quarantine, model cooldown and quota writes is
  Codex-specific code in the worker. Step F adds the shared step
  (`planSubscriptionCoreRefusal`, `subscriptionCoreSettlement`) that the
  worker adopts, with the connector's `classifyError` feeding it (§5.3,
  decision 5);
- capacity waits and wake delivery, the usage fetch, operation candidate
  ordering and the API routes, which call Codex-named wrappers over the
  shared core (the conformance suite drives the shared waiter repository
  directly, not the Codex-named arming wrapper);
- quota decoding: a `decodeQuota`/usage-probe hook on the adapter (PR 0
  adds an optional `fetchUsage`); a spend budget is one usage window of the
  shared quota model (§5.3);
- resolved in PR 0: a `video` operation kind (the 0691 operation-kind CHECK
  and `SubscriptionOperationKind` listed only image, realtime and
  transcription);
- per-model cache facts and model-policy provider ids for an adapter that
  serves several vendors' models (`cacheFacts` and `modelPolicyProviderId`
  are per adapter today);
- resolved in step F: connection administration for API-key connectors. The
  shared writers and the neutral SQL routines manage the kind the binding
  declares (`subscriptionCoreConnectionKind`, from `credentialKind`) and the
  registry row records; the identity rule for keys is the adapter's
  (§5.3, "API-key connectors on the shared core").

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
or `provider_id` comparisons. It fails when a shared module names a
connection kind by literal (`"subscription"`, `'api_key'`) anywhere but a
comment, a union type or the one mapping from the adapter's credential kind
in `subscription-core/provider.ts`. It also fails when the TypeScript registry
and the SQL registry rows differ, in providers or in each provider's
`connection_kind` (an insert that omits the column registers `subscription`).
It is line-based: a conditional split across
lines in an unusual shape can evade it, so review still checks for provider
logic in shared modules.

Module map (old Codex module, its new shared home, and what stays Codex):

| M3 module | Shared module | Kept in the Codex module |
| --- | --- | --- |
| `subscription-core-codex.ts` | `subscription-core/turns.ts`, `subscription-core/credential-resolver.ts` | credential mapping (ChatGPT account id, FedRAMP flag), the turn token resolver wrapper, every exported name |
| `subscription-core-codex-operations.ts` | `subscription-core/operations.ts` | connection token resolver, candidate ordering, plan voice entitlement, usage endpoint fetch and decoding |
| `subscription-core-codex-requests.ts` | `subscription-core/requests.ts` | Apps request reservation and settlement |
| `subscription-core-codex-waiter-cleanup.ts` (now `subscription-core-waiter-cleanup.ts`, every provider; see X3) | `subscription-core/waiters.ts` | nothing since X3 |
| `subscription-core-codex-compat.ts` | `subscription-core/administration.ts` (cutover disposition, workspace and organization pools, personal rows, allocator, extra credits, rename, primary, rotation, workspace source) | the legacy Codex account projection (ChatGPT account id, reset credits, plan history, plan-entitlement exclusions), rotation shape, every exported name |
| `subscription-core-codex-connections.ts` | `subscription-core/connections.ts` (connect personal and shared, disconnect, disconnect all) | the FedRAMP flag as provider state, every exported name |
| `subscription-core-codex-catalog.ts` | `subscription-core/catalog.ts` (serving connections, model admission, readiness) | every exported name |
| `subscription-core-placement-world.ts`, `-repository.ts`, `-acceptance-authority.ts` | same paths, provider-parameterized | Codex-named wrappers in `subscription-core-codex-bindings.ts` |
| (new) | `subscription-core/provider.ts`, `subscription-core/errors.ts` | `subscription-core-codex-adapter.ts` (adapter and binding), `subscription-core-codex-errors.ts` (error classes) |

Every `@opengeni/db` export that existed before this step keeps its name,
signature and behaviour; callers outside `packages/db` are unchanged. The new
shared runtimes are internal to `packages/db` (the package index exports none
of the provider-parameterized entry points; superseded for the worker and
`@opengeni/core` by SuperGrok track X1a in §5.3). Provider-derived texts keep
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
`set_subscription_core_reach` over the provider-keyed
`subscription_codex_auto_assignments` rows,
migration 0713), which the shared core and its access editor
(`subscription-core/access-editor.ts`) call with the provider; Codex's 0702
pair wraps it.
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
| Codex session pin/last columns; xAI/Claude pin rows | One chat binding per session and provider: a manual pin becomes `explicit`; otherwise the most recent pin or last account becomes `automatic` with `last_model_call_at` from the latest model call. Each provider keeps its own row (D-32, 0733): a session with both a Codex and a SuperGrok pin keeps both. Several pool rows of one provider collapse to the one for the session's current pool. |
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
  operation kinds and the two Codex scope-visibility helpers
  (`codex_organization_scope_visible` and `codex_organization_admin_visible`),
  which the shared core does not call; they stay with the legacy policies
  and guards that use them.
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
| Claude `claudeAuthRecovery` turn metadata | `session_turns.metadata.claudeAuthRecovery {credentialId, credentialVersion}` read in `claim.ts` and `failure-settlement.ts` | Replaced by core turn-failure receipts. The cutover converts each live value that names a moved connection's canonical credential at its current generation into a `subscription_turn_failures` row (evidence `{refreshGeneration, refusals: 0}`); an alias's or older version's value is a disposition (C3 below). The metadata stays as history and is no longer read. |
| EP-S18..S24 acceptance writers | `packages/core/src/domain/sessions.ts`, `domain/scheduled-tasks.ts`, `goal-admission.ts`, `session-queue-commands.ts`, `child-outbox-authority.ts`, `claim_session_system_update_outbox` (0234) | X2b/C2b: write the provider's v2 entry at acceptance, and copy compatibility records along every path listed under "Accepted authority across the cutover", dormant until the provider's receipt. |
| EP-T05 lease heartbeat and dispatch fence | `ScopedSubscriptionTurnLease` keyed by subject | Core `SubscriptionTurnLease` (already shared); `ScopedSubscriptionTurnLease` deleted. |
| EP-T07 failure settlement | `failure-settlement.ts` Claude/xAI arm, `classifyXaiCredentialFailure`, `classifyClaudeCredentialFailure`, legacy arm and reconcile | Adapter `classifyError` into shared outcomes; core turn-failure receipts, quarantine, failover bound and wait. Claude's `claude_token_renewed` / `claude_credential_changed` recovery becomes the core rule "unauthorized: one forced refresh under the lock, then retry the same connection if the generation advanced". Claude 529 stays in the provider-overload lane (`overloaded`), never account rotation. |
| EP-T08 finalization | Claude usage receipts; xAI per-turn quota fetch; factory lease release | Core lease release and binding clock. Claude header usage (EP-N25) is decoded by adapter `decodeQuota` and recorded against the leased connection with the observed refresh generation. The xAI per-turn billing call is removed; quota is observed on refusal and by the bounded out-of-turn probe. |
| EP-T09, EP-T10 waits and wakes | `getCodexCapacityWait` probes the xAI then Claude factory waiters; `reconcileCodexCapacityWait` branches on `provider`; `wakeSubscriptionCapacityWaiters`, `wakeOrganizationPool` | Core waiter and wake outbox. Activity and signal names, the optional `provider` field and its "absent means Codex" meaning stay for the legacy peek; core reconciliation looks the waiter up by its id and generation regardless of `provider`, so a recorded `provider: "xai"` or `"claude"` reconciles against the core waiter with the same preserved waiter id and generation. Organization wakes use the provider-neutral workspace enumeration. |
| EP-T11..T15, EP-N27 accepted authority, goals, children, inbox, schedules | v1 readers in `accepted-subscription-authority.ts`, `session-queue-commands.ts`, `child-outbox-authority.ts`, `parent-wake.ts`, `scheduled-tasks.ts` (xAI human from `createdBy`, Claude from `ownerSubjectId`) | After the provider's cutover: the v2 entry written at acceptance, else the copied compatibility record, else no personal authority, through one provider-neutral reader. Schedules use the revision's authorizing membership for every provider (ends the EP-N27 asymmetry). |
| EP-T16 compaction | Same capacity phase; cancelled with `requestPreserved` when no account | Core compaction placement exactly as Codex PR 2c (cancel, never park). |
| EP-T17, EP-N12 in-turn video funding and selection | Live acceptance for non-xAI turns, un-leased `selectXaiCredentialForUse`, writes a policy pin | As built in X2a: the first shared organization- or workspace-scoped candidate for the session's recorded owner whose stored quota is not exhausted funds the video (the session's explicit choice, then the effective primary, then pool order), for every chat model; the operation stores only a reference to that connection. Submission and polling take a session-bound `video` operation lease keyed by the operation, not the turn: the job outlives its turn, so neither a personal connection nor the turn's own chat connection (which may be personal) funds it. Never reads or writes the chat binding. |
| Claude custom-model admission (`organization-model-providers.ts`) | Session creation reads the new session's `initial_claude`; fresh prompts pass the snapshot computed at acceptance; scheduled-task updates pass the task's frozen snapshot (`domain/scheduled-tasks.ts`). Admits only `organization` with a live organization Claude account (`workspaceClaudeSubscriptionActiveForAuthority`) | After C3: session creation and fresh prompts are always new acceptances and admit when the workspace's effective Claude source admits organization connections and a serviceable organization-scoped Claude connection exists. Scheduled-task updates read the task's `scheduled_task` record (admit only when `shared_pool` is `organization`) or, for post-cutover tasks, apply the same source rule; the liveness requirement stays in both cases. |
| EP-T18, EP-S25, EP-N26 model listing and readiness | `loadWorkspaceModelSelectionInput` with frozen v1 snapshots; `connectionRestrictionsAndXaiReadiness`, `loadWorkspaceClaudeSubscriptionReadiness` | The core eligibility projection used for Codex (shared pools; personal only through the owner-only reader in the owner's Personal workspace or for an exact accepted turn). |
| EP-N03 SuperGrok transcription | Caller's live pool, personal wins, no lease | Codex PR 2c rule: sessionless `transcription` operation lease on a shared organization- or workspace-scoped connection; personal and people-scoped refused; once selected, failures are not retried through another provider. |
| EP-N05, EP-N07, EP-S17 realtime | Caller's live pool, writes the session pin, no lease | Codex PR 2c rule: the session's recorded owner, shared capacity only, `realtime` operation lease through negotiation, refresh under the lock; never writes the binding. |
| EP-N09, EP-N10 SuperGrok image | Turn credential; no dispatch-rejection hook | `image` operation lease keyed by turn and call; add `isProviderDispatchRejected` so a refused lease or fence returns the ledger row to `prepared` instead of outcome-unknown. |
| EP-N11 video policy route | Saving administrator's live pool | "A shared xAI candidate exists for this workspace" (no viewer, no personal). |
| EP-N13, EP-N14 video admission and reconciliation | Envelope with access and refresh token; organization scope rejected; direct `refreshXaiToken` outside the lock | The operation references the canonical connection; reconciliation reads the credential through the core connection seam under the operation's `video` lease and refreshes only under the core lock. No token envelope, so both defects disappear. |
| EP-N19, EP-N20 funding and attribution | Static overlay for xAI and Claude | Core funding result with explicit workspace, owner, accepted authority and model (the Codex `isCodexBilledTurn` rule, provider-neutral); `model_call_facts.connection_id` attribution. |
| EP-N22, EP-N23 xAI quota refresh and status probe | List-all refresh; a third auth-context copy | Core quota probe per connection with explicit context (adapter `fetchUsage`); status validates a shared effective primary with `liveModels`. Own personal accounts count towards connected status; in the owner's Personal workspace, without a shared primary, a verified owner may validate an active personal account through the administered billing probe. Other callers get stored counts, never another person's live probe. |
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
| Administered usage reads (below): a live usage probe for an organization administrator on the organization route and for a personal connection's owner in their own Personal workspace (0735, renumbered at merge). | Legacy read organization and user-scope accounts live for Claude and SuperGrok (D-01), and Codex's organization usage reads live; the workspace connection seam serves neither. |

#### Administered usage reads

The workspace connection seam (`operation-connections`) cannot read a
connection outside a workspace pool: its target routine
(`subscription_core_connection_target`, 0707) needs a workspace and, without
a turn lease, returns shared connections only. Legacy read organization and
user-scope accounts live (D-01). `subscriptionCoreAdministeredConnections(provider)`
(`subscription-core/administered-connections.ts`) adds a provider-neutral
usage probe, `probeSubscriptionCoreAdministeredConnectionUsage`, with the
workspace probe's staleness refresh, adapter `fetchUsage`/`decodeQuota`
(including `modelIds`) and generation-fenced quota merge, and the same
result shape (`SubscriptionCoreUsageProbe`, with `applied` and
`recovered`). It has two scopes, each re-established in every transaction
it opens and never borrowed:

- `organization_administrator`, generalized from Codex's organization usage
  read (an administrator check, then a live read): the organization context
  with no workspace, the organization membership lifecycle lock taken before
  the check (waited for at most five seconds; a busier organization refuses
  the read as not visible), the caller's subject, the `subscription_organization_admin`
  predicate the connection policies use, and an enabled cutover. Only a
  shared connection of the provider's registered kind that no workspace
  manages (`managed_by_workspace_id is null`), not disconnected, is read; a
  workspace-managed connection stays with its workspace. The credential
  refresh (under the per-connection refresh lock) and the quota write go
  through the administrator's row policies.
- `personal_owner`: the owner's own Personal workspace context and subject.
  Every read and write goes through three owner-only routines (0735): the
  credential read, the refresh begin (which takes the per-connection
  refresh lock and mints the 0707 `connection_refresh_authorized`
  capability that the unchanged 0707 persist and fail writers consume) and
  the quota write (fenced on the refresh generation and on the stored quota
  revision the caller merged from). Each admits only the 0707 writer
  context (the transaction's account, workspace and `user:` subject, an
  enabled cutover of a registered provider), the owner's exact active,
  unrevoked membership whose Personal workspace is the given workspace, a
  personal connection of the registered kind that this membership owns, not
  disconnected, and an active, unrevoked authority of that membership at the
  connection's current authority generation, and the organization's
  effective personal-connections rule (`personalConnectionsAllowed` from
  `subscription_effective_settings`, exactly as the 0707 turn target,
  refresh begin and personal connect apply it, so an override of a locked
  setting is ignored). The 0707 `connection_owner`
  capability is held only while a routine runs. A shared workspace, another
  member, a service actor and an ownerless session (which has no person)
  never reach the credential. A test pins these predicates to the live 0707
  routines that state them, so the two cannot drift apart.

Request custody. Each provider request runs in a transaction that holds the
per-connection refresh lock, rechecks the scope's authority and that the
credential is still active at the bearer's refresh generation, and buffers
the bounded response (`redirect: "error"`, 1 MiB) before it ends. The
deadline, which includes the locks and the recheck, is five seconds on the
organization route, whose transaction also holds the organization
membership lock for the request (Codex's organization usage budget), and
ten seconds for an owner's personal read. Only native fetch, or an injected
transport that aborts and joins its local work for the request's signal
(as Codex's organization read requires), is accepted; any other is refused
before a credential is loaded. A disconnect or refresh waits for the request
(both take the refresh lock), and so does an organization membership change
on the organization route. An owner's membership or authority change does
not wait for a personal request, but no request starts after it, and the
quota write rechecks both and drops the reading. Credential refresh flights are
namespaced by scope. Every outcome is reported, never thrown; a refused
scope is `not_visible` and reads nothing. Nothing here changes allocation,
policies or assignments.

Quota writes are fenced on the refresh generation they read, not taken
under the refresh lock (no new lock order): a reconnect that commits between
that read and the write can let one older reading land, stamped with its own
generation, the same window as the workspace path. The organization write
merges under the quota row lock, as the workspace path does; the owner's
write merges from the owner reader and is fenced on the revision it merged
from, so a reading that raced another quota write at the same generation
re-reads and re-merges once before it is dropped.

Stored state without a credential read. A person's own personal
connections, with their status and stored quota (exhaustion, windows and
cooldowns), are already readable without a credential through the 0707
owner reader (`listSubscriptionCorePersonalConnectionRowsInTransaction`):
exact owner membership, in their Personal workspace or a workspace they are
a member of. A provider's status route serves personal-only users from that
reader and refreshes live through `personal_owner` only for the verified
owning person (the private-account owner check, below); no further routine
is needed for the stored re-read.

Known limit (not fail-open). These reads record no workspace operation
ledger entry: the organization route has no workspace, and the ledger's
credential check refuses personal connections. A usage read moves no money
and changes no allocation; its custody is the locked, rechecked transaction
above, and the quota write is fenced as on the workspace path.

The workspace probe's credential load, rotation and usage-merge steps are
factored out of `subscription-core/operations.ts` with unchanged behaviour
(`subscriptionCoreConnectionCredentialLoad`,
`rotateSubscriptionCoreConnectionCredential` through a
`SubscriptionCoreCredentialRefreshWriter`, and
`mergeSubscriptionCoreUsageObservation`), so both probes share them.

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
| Health and quota | Status 1:1. Both the connection `version` and `refresh_generation` start from the legacy `version`, for both providers. xAI `quota_used_percent`, `quota_reset_at` and `exhausted_until` become one quota window and `exhaustedUntil`, whose kind is `rate_limit` when the legacy `last_error` records a rate-limit refusal and `quota` otherwise. Claude usage windows and `model_cooldowns` move to the quota row; the observed generation is set only when the usage row's `credential_version` equals the credential `version`, else NULL (unknown, never exhausted). A usage `reconnect` flag is dropped: it is a response value derived at read time, and a needed sign-in is carried by the connection status (C2a). Allocator counters: `selection_count` is summed and `last_selected_at` maxed over the group into the connection's quota row; the rotation row's `fairness_cursor` has no core column and is a disposition (core `spread` orders by a per-session hash and keeps no cursor). |
| Rotation settings | Only pools in effect map: the organization row to organization `rotation.<provider>`, workspace rows to workspace overrides. Rotation on (also when no row exists) is `spread`; off is `primary_first` with the alias-resolved active pointer as the provider primary. User-pool rotation rows have no equivalent (disposition). |
| Source | Legacy acceptance used the workspace pool when the workspace had its own credentials, else the organization pool; it never admitted organization accounts while local accounts existed. A workspace with workspace-scope credentials of the provider gets `inference_source = workspace`; other workspaces get no override (`automatic`, which today admits only organization connections there). `enabled` stays true. This deliberately diverges from §5.2's Codex `automatic` row (no override, rotation to keep local first): legacy Codex `automatic` already mixed both pools, so leaving it automatic was exact, whereas freezing `workspace` is the exact preservation for SuperGrok and Claude and the strictest one. Release note: such workspaces stop using organization accounts only if an administrator later changes the source, as today. |
| Session pins | One binding per session and provider (D-32; requires the provider-keyed binding precursor). Among that provider's pool rows, the row of the pool in the session's latest accepted v1 snapshot wins. A manual pin is `explicit` (owner-only, non-dispatching seam; kept when unhealthy); a policy pin, else the last account, is `automatic`. A personal target is kept only when the session owner owns it and the session is private or in their Personal workspace; otherwise disposition `pin_owner_ineligible`. Every eligible pin in the effective pool moves regardless of the current model or other providers' bindings; other providers' rows remain exactly unchanged. An already-populated destination provider aborts preflight, and ambiguous effective-pool pins still abort. The first drained cutover drops the rolling session-only index before binding writes or activation; later cutovers tolerate its absence. Keep the provider-fixed trigger enabled throughout. `last_model_call_at` comes from the latest model-call fact. |
| Leases | Live leases move with turn, holder, generation, expiry and the alias-resolved connection; parity compares exact tuples. Expired leases are a disposition; a live core lease on the same turn aborts (`lease_conflict`). |
| Waiters | Only `waiting` rows whose blocked turn and generation equal the session's parked turn move; others collapse with a disposition. When several of the provider's pool waiters match the parked turn, the one for the pool of the turn's v1 snapshot moves (the `user` pool for a `user` snapshot). Preserve the legacy `id` as `waiter_id`, `generation`, `wake_revision`, `observed_wake_revision`, `next_check_at`, `earliest_reset_at`, `blocked_turn_generation`, the goal fence and `last_wake_reason`. `wait_reason` takes a core value derivable from the legacy row, which records no reason: `pinned_account_unavailable` when the session's moved binding is explicit, else `no_eligible_capacity`; the core reconcile sets a more specific reason at its next check; `reset_kind` takes the core's values: `authoritative` when a future reset is known, else `mutation_only`. `workflow_id` must equal the session's workflow id, else abort. Any existing core waiter for the session aborts the cutover (`waiter_conflict`); the migration never modifies another provider's waiter or lease. A pending wake (`wake_revision > observed_wake_revision`) gets a wake-outbox row. |
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
| 0. Generic precursor | Receipt table and provider-keyed readiness; switch-row and core-connection restrictions before a receipt; compatibility relation, reader and copy routines (inert); the server-owned `authority_inserted_at` marker on carrier tables; `authorize_subscription_personal_access` (0668's legacy-generation v1 branch replaced, not generalized) and the 0667 placement helper: a provider with an enabled cutover reads its v2 entry or compatibility record and requires the exact owner membership, the current generation, `personalConnectionsAllowed` and, for records, `connectionIds`; a disabled row grants nothing; until a provider's receipt both helpers return false for that provider (`xai`, `claude`), whose personal access is decided only by its v1 path. Fence 0608 and the scheduled occurrence also compare v2 (scheduled admission relies on the v2 value its pinned revision carries; see part 2's Admission choice), the Claude scheduled comparisons and `scheduled_claude_authority_changed` are added, the v1 liveness check switches at the receipt, and the compatibility deferred triggers are installed. PR 0 merges before any X1a or C1a call site, because 0667 and 0668 already accept any provider; provider-checked primaries; `video` operation kind; `model` and `credential_request` kinds and the unknown-outcome replay fence widened beyond Codex; wait reason `accepted_authority_unavailable`; provider-keyed `model.connected` lifecycle fact on core connection insert; provider-keyed cutover planner and auto-assignment if M4-A lacks them; adapter interface additions; provider-keyed report relation. | rolling |
| X1a. SuperGrok adapter and chat placement | The xAI adapter and its conformance suite; chat placement, materialization, refresh, request custody (`model` / `credential_request` rows, including hosted-search continuations), session-title requests, readiness, `list_models`, funding and attribution on the core with `provider = xai`. | rolling |
| X1b. SuperGrok settlement and waits | Failure settlement through adapter `classifyError`, finalization, waits, wakes, Temporal reconciliation by waiter id, compaction. | rolling |
| X2a. SuperGrok media and probes | Image, video (funding, selection, admission, reconciliation), transcription, realtime, status and quota probes. | rolling |
| X2b. SuperGrok routes and writers | Routes, access policy, SDK and event projections; connect, disconnect and personal writers; EP-S18..S24 v2 entry writers and the compatibility copy routines on every path. Lands before X3 so connect and disconnect work after the cutover. | rolling |
| X3. SuperGrok drained cutover | Codec stage, data move, compatibility records, parity report, receipt, switch rows enabled; role provisioning and the posture contract stop granting legacy writes; runbook section. | maintenance |
| X4. SuperGrok legacy deletion | Removes the xAI selector arm, factory repository use, v1 xAI readers and writers, xAI use of `ScopedSubscriptionTurnLease`, the video envelope code and the shadow; extends the guard below to xAI. Merges only with the `compat:dependent_sources_without_record` copy-path test green. | rolling |
| C1a, C1b, C2a, C2b, C3, C4. Claude | The same steps. C1b reads core turn-failure receipts in place of `claudeAuthRecovery`; C2a covers the usage routes; C2b covers the OAuth and setup-token writers; C3 converts live `claudeAuthRecovery` values and includes the combined-window ledger test; C4 deletes the Claude arm, `claude_subscription_account_usage` use and the dead connection-based usage code. C3 precondition: live usage refresh on the organization route (organization administrators) and for an owner's personal connection in their own Personal workspace has merged (C2c, #4157 and its provider-neutral split); C3 does not register `SUBSCRIPTION_CORE_CLAUDE` while either refresh still answers `unavailable`. | as X1a..X4 |
| F. Fake API-key adapter conformance | A test-only adapter (`kind = api_key`, static credential, no quota windows, no refresh) driven through the same core placement, lease, failover and wait paths as subscriptions and compared with the reference model; scripted local upstream and a network-denial guard. No production table, provider row or route; one migration (0715) makes the neutral routines read the connection kind from the provider registry. Lands after PR 0. See "API-key connectors on the shared core" below. | rolling (the connector is test only) |
| W. Workspace-managed connections as organization accounts | [§5.4](#54-workspace-managed-connections-as-organization-accounts): 0714 lets the provider-keyed reach setters accept a connection managed by a shared workspace, makes the reach reader report the reach row's switch and list, and adds `set_subscription_core_reach_allocator` (organization administrators only); the organization access editor reads and saves its reach (people scope only for unmanaged accounts); the Accounts page change ships separately after owner approval. Applies to SuperGrok and Claude through X3 and C3, which map workspace credentials into the same shape. | rolling (no row changes) |
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
`*_subscription_capability_insert`, `*_subscription_capability_revoke`,
`*_subscription_membership_lock`; the catalog has all four for both
providers); the
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
  `v1` either way. The neutral connect writers take the format from X2b on
  (`credentialFormat`, and 0728's personal writer overload); `v1` when
  omitted, as Codex does.
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
  deferred triggers; fence 0608 and the scheduled occurrence comparing the
  v2 slot (scheduled admission relies on its pinned revision; see part 2's
  Admission choice), the Claude scheduled comparisons and
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

#### PR 0b: authority compatibility and fences

PR 0b ships as three rolling PRs, stacked in this order, and every PR 0b item
of row 0 above lands in exactly one of them:

- **Part 1 (migration 0716), inert:** the server-owned
  `authority_inserted_at` marker; the compatibility relation; the per-path
  resolvers; the copy routine and the reader; the compatibility deferred
  check triggers; the compatibility-record branch of both personal helpers
  (`connectionIds`). They act only for a provider whose own drained cutover
  wrote a receipt with a real commit time, which no provider has yet.
- **Part 2 (migration 0717), acts on deploy:** fence 0608 and the scheduled
  occurrence comparing the v2 slot, and scheduled admission (see its choice
  below); the Claude scheduled comparisons and
  `scheduled_claude_authority_changed`; the v1 liveness check switching to
  the core check at the provider's receipt; the inbox batching key carrying
  each provider's effective authority; the pre-merge inventories (the
  patched functions, the existing rows the new comparisons reject, and the
  callers of `validate_scheduled_agent_run_live_authority`); and the defects
  in earlier merged work listed there.
- **Part 3 (migration 0726), acts on deploy:** a defect fix in earlier
  merged work found while testing part 2: the v2 acceptance writers and the
  two health-recovery routines see the owner's personal connections under an
  owner bound by row security.

Choices made where the plan left room, for reviewers:

- **Relation.** `opengeni_private.subscription_authority_compat` belongs to
  the migration owner; runtime roles hold no privilege on it. Besides the
  planned columns it stores `workspace_id` (every carrier is workspace-bound,
  so session, turn and update references are composite `(workspace_id, id)`
  foreign keys) and `owner_subject_id`, the human whose personal authority
  the record carries (a `user` record, or one with a personal entry; NULL
  otherwise). Narrowing compares the causal human with this column, so a
  copy never has to re-derive the owner from the source's lineage. A content
  CHECK enforces the mapping table's shapes: `organization` has
  `shared_pool = organization` and no entry, `workspace` has `workspace`,
  `user` and `missing` have `none`, `missing` has no entry; at most one entry
  with exactly `ownerMembershipId` (a UUID), `authorityGeneration` (a
  positive safe integer) and 1 to 64 distinct connection UUIDs.
- **Row security.** FORCE RLS with a SELECT and an INSERT policy: a record is
  visible exactly when its carrier row is visible to the same account and
  workspace under the reader's own row security (which carries session
  visibility). There is no UPDATE or DELETE policy, so even the owner changes
  nothing; a guard trigger rejects UPDATE and TRUNCATE for every role and
  DELETE unless it runs inside a referential cascade from the carrier
  (`pg_trigger_depth() > 1`), so session, task and organization deletion keep
  working. The depth test would also admit a DELETE issued from some other
  trigger, but none exists and only the owner's cascade (exempt from row
  security) or a `BYPASSRLS` role can delete at all. INSERT requires the
  provider's receipt with a commit time later
  than `-infinity` (`55000`): Codex and providers without a receipt never
  hold records.
- **Marker.** `authority_inserted_at` on `sessions`, `session_turns`,
  `scheduled_tasks`, `scheduled_task_revision_authorities`,
  `session_system_updates` and `session_system_update_outbox` (constant
  default, metadata-only). The stamping trigger is named `zzz_…` so it runs
  after every other `BEFORE INSERT` trigger and nothing can replace its
  value; the immutability trigger fires only when the value changes. Both
  bind every role, including the owner.
- **Lock order.** The migration takes ACCESS EXCLUSIVE on the six carrier
  tables first, in one statement, in the runtime's order (`sessions`,
  `session_turns`, `session_system_updates`, `session_system_update_outbox`,
  `scheduled_tasks`, `scheduled_task_revision_authorities`), and locks no
  other runtime table. No static order is cycle-free for all six (runtime
  work takes sessions before turns, but scheduled dispatch can lock a task
  before creating its session, and deleting a session reaches tasks through
  a foreign key), so the statement runs with a 100 ms per-wait lock timeout
  inside a savepoint and is retried after a short pause until it holds the
  whole set (30 s at most, then `55P03`, safe to retry). An attempt that
  fails releases everything it took, so the migration never holds a carrier
  lock for more than about 600 ms while it waits: a runtime transaction that
  waits behind it gets its lock before PostgreSQL's deadlock check (default
  `deadlock_timeout` one second) could pick it as a victim, and the
  migration abandons each wait before its own check. A first draft took the
  locks one `ALTER TABLE` at a time, `session_turns` first, and a reviewer
  reproduced `40P01` against live session work; the race test
  `migration-0716-authority-compat-lock-order.test.ts` covers both orders.
- **Marker and the task digest.** The scheduled-task execution digest hashes
  the task row as JSON, so the marker would change every task's digest on
  its next rename or pause and invalidate run receipts holding the old one.
  The digest function and its trigger now exclude `authority_inserted_at`
  (the anchored replacement 0688 used for `subscription_authority`). The
  unused `scheduled_task_execution_state` is left as it is.
- **"Inserted by this transaction"** is the marker equal to
  `transaction_timestamp()`. The copy routine copies only into a carrier its
  own transaction inserted, and the receiver and compaction resolvers skip
  turns the current transaction inserted (the writer resolved its source
  before inserting them). Two transactions that start in the same
  microsecond are indistinguishable here; the record content is still
  computed from the verified source, never supplied.
- **Resolvers.** One owner-only function,
  `opengeni_subscription_internal.subscription_compat_carrier_sources(kind,
  workspace, id, revision)`, returns each carrier's sources by path, with the
  causal human used for narrowing:

  | Carrier | Path | Source |
  | --- | --- | --- |
  | turn of a scheduled run | scheduled firing | The run's task revision (the task itself when the revision row is missing); personal only when the revision's authorizer is the task owner |
  | `system` or `goal` turn | delivery | When every delivered update is a goal continuation: the causal turn of the first one in delivery order (`created_at`, then `id`), only when its `initiating_human_subject_id` is the delivering turn's (else none, as the Codex v2 writer). Otherwise, with an execution context: the context turn and every delivered causal update (not Agent messages or child results, which 0608 checks by human only). Otherwise: each delivered update |
  | `compaction` turn | compaction | The turn of the session's latest `turn.started` event (`latestStartedSessionTurnRow`), excluding turns this transaction inserted |
  | `user` or `api` turn with `lineage.editedFromTurnId` | edit | The exact turn withdrawn for this edit (same session, `withdrawn_for_edit`, the same human); anything else is refused (`23514`). The copy is verbatim, as the queue writer copies v1, v2 and the human |
  | `user` or `api` turn submitted by an agent attempt | agent prompt | The receiving session's source: execution-context turn, else latest accepted turn (both excluding this transaction's turns), else spawning parent turn, else `session_initial` |
  | first `user` or `api` turn of a child or scheduler-created session | creation | The parent turn, or the occurrence's revision |
  | any other turn (including the first turn of a human-created session, whose v2 the start computes afresh); archive-imported sessions | new acceptance | none |
  | `session_initial` | creation | The parent turn of a child; the occurrence's revision for a scheduler-created session; else none |
  | scheduled task | agent-created task | The creating turn (the last agent hop of the frozen creator context); personal only for an owner destination (Personal workspace, or the owner's private reusable session); else none |
  | task revision | revision | The task; personal only when the authorizer is the task owner (0688's v2 derivation rule), so a clone on rename or pause yields what its predecessor yields |
  | update of a scheduled run | scheduled occurrence | The run's revision |
  | Agent Message or Steer update | receiver | The receiving session's source; personal only for the sender's causal human |
  | child result update | child result | Its outbox row (same workspace, target session and dedupe key), else the `parentTurnId` turn |
  | other updates | causal | The `causalTurnId` turn |
  | outbox row | child outbox | The child's spawning parent turn |

  The copy routine, the deferred check and part 2's fences use only this
  function.
- **Edits.** The queue's Edit resubmits a withdrawn prompt and copies its v1
  snapshots, v2 value and human verbatim, a copy path the table under
  "Writing" does not list. Treating the resubmission as a new acceptance
  would drop a source record's narrowing (a widening), so it is a path of
  its own. No column linked the two turns (the draft's `source_turn_id` is
  cleared in the submitting transaction), so the writer now records
  `lineage.editedFromTurnId` on the resubmitted turn, and the resolver
  verifies it. Older binaries omit the link; that matters only after a
  provider's receipt, when they no longer run. The provider cutovers (X3,
  C3) must also write records for turns withdrawn for edit that a composer
  draft still references, or an edit submitted after the cutover waits with
  the `missing` copy.
- **Copy rule.** As "Writing" above: a source with the provider's v2 entry
  yields no record; a source record is copied verbatim when it is `missing`,
  ownerless, or its owner is the causal human; otherwise the entry is dropped
  and a remaining `workspace` or `organization` narrowing is copied, and a
  `user` record yields no record; a source with neither that predates the
  receipt yields the `missing` copy. A carrier with several sources (a
  delivery batch) requires them all to yield the same copy (`23514`
  otherwise).
- **Deferred check.** A `DEFERRABLE INITIALLY DEFERRED` constraint trigger
  (`zzz_subscription_authority_compat_check`, `AFTER INSERT`) on each carrier
  table. It returns after one lookup in the receipts table while no receipt
  has a real commit time. Otherwise, for each such provider, it requires the
  stored record to equal the expected copy in every content column (or to be
  absent when none is expected) and, when the source has a record or
  predates the receipt, no v2 entry for the provider. A carrier deleted later
  in the same transaction is skipped. The copy routine and the check resolve
  under the carrier's own account and workspace with an empty subject, and
  restore the caller's settings, so both see the same sources. A deferred
  row trigger fires at the first constraint flush after the insert, which is
  not always the commit: every session-activity scope
  (`withSessionActivityRlsContext` and each
  `withRestoredSessionActivityRlsContext`) runs `SET CONSTRAINTS ALL
  IMMEDIATE` when it finalizes, and so do `fork_session_content` and the
  0263/0278 membership commands. A writer must therefore copy inside the
  same activity scope as the carrier insert, before that scope finalizes.
- **Copy routine.** `opengeni_private.copy_subscription_authority_compat
  (provider, carrier_kind, workspace_id, carrier_id,
  task_authority_revision)` takes no content. It returns false without a
  real-time receipt (inert), requires the caller's account and workspace
  settings, a carrier visible to the caller and inserted by its own
  transaction (`55000` otherwise), and is idempotent. It returns whether the
  carrier now holds a record. Nothing in the runtime calls it yet; the
  provider writers (X2b, C2b) will, each in the activity scope that inserted
  the carrier (see the deferred check).
- **Reader.** `opengeni_private.read_subscription_authority_compat` (same
  arguments) returns `{authority: v1}` before the provider's receipt, `v2`
  when the carrier holds the provider's entry, `record` with its content,
  `missing` (`personal: []`, `sharedPool: none`: the work waits) for a
  pre-receipt carrier with neither, `none` for post-receipt work with
  neither, and NULL when the carrier is not visible to the caller.
  The answer itself comes from the owner-only
  `opengeni_subscription_internal.subscription_compat_effective` (same
  arguments, no visibility check), which part 2's fences also use.
  `opengeni_private.subscription_authority_compat_providers()` lists the
  providers that can hold records (empty while only Codex is cut over).
- **Neutrality.** The shared routines take the provider as data and name no
  provider in code (only comments say that Codex holds no records).
  `check:subscription-core-neutral` scans TypeScript only; SQL neutrality is
  checked by review. Extending the guard to migrations would flag part 2's
  intentionally per-provider v1 checks and policies.
- **Personal helpers.** Both helpers read the turn's (`session_turn`) record
  whose `owner_subject_id` is the session owner, only when the turn has no
  v2 entry for the provider. `authorize_subscription_personal_access` then
  requires the entry's membership to be the connection's owner membership
  (which it already requires to be the session owner's active membership),
  the entry's generation to be the connection's current generation, the
  connection to be listed, and `personalConnectionsAllowed`. The placement
  helper reads the record's connections for the requested membership and
  generation; with none it refuses, and otherwise it mints capabilities and
  checks visibility only for those connections. The v2 branches are
  unchanged. Both patches are anchored replacements of the live definitions
  (each anchor must occur exactly once).
- **Grants and posture.** The copy routine, the reader and the provider list
  are granted to every configured application role (0712's pattern); every
  other new routine is owner-only in `opengeni_subscription_internal` with
  `search_path = pg_catalog, <data schema>, opengeni_private, pg_temp`. The
  previous release's posture check passes against the migrated schema before
  and after role provisioning.

Part 2 (migration 0717) patches the live definitions by anchored
replacement (each anchor must occur exactly once, so a drifted definition
aborts the migration) and adds four owner-only helpers in
`opengeni_subscription_internal` (no grant; the runtime posture requires all
four, owner-only with a safe search path, once any exists, and
provision-roles revokes them from the runtime role). Choices:

- **v2 copy rule.** A copied v2 value matches its source's when it is the
  same value or, when the source froze none, when it is none or the empty
  value `{"version":2,"personal":[]}` (the Codex writers store the empty
  value once the Codex cutover is enabled; neither widens). One helper,
  `subscription_v2_copy_matches`, serves every fence below.
- **Inbox fence (0608).** The delivering turn's v2 value must match its
  delivery source from 0716's delivery resolver: for a pure goal
  continuation the first continuation's causal turn (none when its human is
  not the turn's), otherwise the receiving context turn. A delivered causal
  update (wait timeout, background command result, goal continuation in a
  mixed batch) that froze a value must carry the turn's value; one that froze
  none follows the context, as the planner batches it. Agent Messages and
  child results stay checked by human only, as in 0608. After a provider's
  receipt with a real commit time, each causal update's effective authority
  for that provider (0716's `subscription_compat_effective`) must equal the
  context turn's, unless the update froze no v2 value and is post-receipt
  work without a record (the same exception as above).
- **Inbox batching key.** `systemUpdateExecutionAuthorityKey` and the
  receiver-context comparison in `planInboxBatch` add each carrier's
  effective authority per provider holding records
  (`subscriptionAuthorityCompatForCarriersInTransaction`, one reader call
  for the context and the candidate updates), with the fence's exception, so
  the planner never batches what the fence refuses. The map is empty while no
  provider has a real-time receipt, so every key is unchanged until then.
- **Scheduled occurrence.** `validate_scheduled_occurrence_accepted_execution`
  compares the Claude snapshot with the run's accepted one and
  `lineage.claudeAuthoritySubjectId` with the accepted causal subject, and
  the v2 value with the value its firing copies: the revision's frozen
  value, narrowed to the empty value when it holds a personal entry and the
  revision's authorizer is not the task owner (the writer's rule,
  `subscription_scheduled_firing_v2`). Either the accepted snapshot's
  revision or the run's current revision is accepted, because a
  reusable-connection materialization advances the run's revision after
  acceptance. A run accepted without a Claude snapshot (before 0598) compares
  as the column default `{"version":1,"scope":"workspace"}`, here and below.
- **Immutability.** `fence_scheduled_occurrence_update` and
  `fence_scheduled_turn_execution_update` keep the Claude snapshot and the v2
  value for every role, as they do for xAI (the generic v2 immutability
  triggers exempt the table owner). The `scheduled_turn_execution_immutable`
  trigger listed only the xAI snapshot column, so a Claude or v2 update never
  reached its fence; it is recreated with both columns.
- **Admission.** `admit_scheduled_agent_run_execution` compares the accepted
  Claude snapshot with the task's (`40001`, "accepted execution changed
  during admission", as for xAI). The accepted causal subject must be the
  task owner for a `user` Claude snapshot (an ownerless task is never
  admissible), and then also for a `user` xAI snapshot, because the
  dispatcher derives one causal human; other scopes carry no Claude subject
  (`42501`).
  Admission adds no v2 comparison of its own, although row 0 lists one:
  admission already pins the run's `task_authority_revision` to the task's
  current revision and the execution digest; 0688's trigger derives the
  revision's v2 value from the task's, which
  `scheduled_tasks_subscription_authority_immutable_trg` keeps immutable;
  runtime roles hold no privilege on `scheduled_task_revision_authorities`,
  whose only inserters (0275, 0478) never supply the column; and the
  occurrence fence compares the v2 value the firing copies. A comparison at
  admission would re-check a value nothing can make differ, and re-deriving
  0688's rule there could refuse admissible runs if the two copies of the
  rule drifted. A later migration that lets a writer supply the revision's
  v2 value must add the comparison.
- **Generated session.** `fence_scheduled_task_run_connection_session_identity`
  compares the generated session's `initial_claude_provider_account_authority_snapshot`
  with the accepted one.
- **Live authority.** `validate_scheduled_agent_run_live_authority` returns
  `scheduled_claude_authority_changed` when a `user` Claude snapshot's
  causal membership no longer holds an active, unrevoked
  `claude_subscription` authority at the accepted generation, mirroring
  `scheduled_xai_authority_changed` and locked in the same statement. Its
  callers inherit the refusal: the host MCP turn guard (0447), the external
  link snapshot guard (0452), MCP operation scoping (0459), and the
  scheduled claim in `packages/db/src/index.ts`, which fails the run and its
  occurrence with the code and creates no attempt.
- **Receipt switch.** After a provider's receipt with a real commit time,
  its v1 check no longer runs. Instead every personal entry the run carries
  for that provider (the firing's v2 entry, else the entry of the revision's
  compatibility record as the occurrence copies it,
  `subscription_scheduled_run_personal_entries`) must be serviceable: an
  active personal connection of that provider owned by the entry's active
  membership whose authority row is active at the entry's generation and,
  for a record, one of its listed connections
  (`subscription_personal_entry_serviceable`). The code is
  `scheduled_<provider>_authority_changed`, the v1 code. Codex has no
  real-time receipt, so nothing changes for it. The live check runs as the
  owner, whom FORCE RLS binds, and a `lifecycle` capability does not expose
  personal connections, so the helper reads connections, memberships and
  authorities through the owner-only membership-lifecycle read
  (`opengeni.organization_tenancy_lifecycle =
  'organization_membership_lifecycle'`) and restores the caller's marker. A
  marker rather than a capability row keeps the check write-free.
- **Defects fixed on the way.** The three 0608 `SECURITY DEFINER` routines
  (`fence_session_execution_context`, `advance_session_execution_context`,
  `fence_inbox_execution_context`) ran with the migration's search path
  (`"$user", public`), which searches `pg_temp` first for relations; they
  now use the helpers' path with `pg_temp` last. 0598 copied the xAI
  policies of `organization_memberships` by the name pattern
  `xai_subscription_capability_%` and missed 0442's
  `xai_subscription_membership_lock`, the UPDATE policy FORCE RLS needs for
  the membership lock in `create_claude_subscription_credential`; under an
  owner without `BYPASSRLS` connecting a personal Claude account failed with
  `42501`. 0717 adds `claude_subscription_membership_lock` (lock only,
  `WITH CHECK (false)`). The personal SuperGrok and Claude disconnects
  delete the credential and then revoke its `xai_subscription` or
  `claude_subscription` authority, but no policy lets the provider's
  lifecycle capability update `organization_user_resource_authorities`;
  under such an owner the revoke matched no row, so the authority stayed
  active and runs accepted for the disconnected account kept passing the
  `user` generation check. 0717 adds `xai_subscription_capability_revoke` and
  `claude_subscription_capability_revoke` (UPDATE of the provider's own kind
  to `revoked` only, as Codex's `subscription_codex_owner_authority_revoke`),
  and revokes the active authorities whose credential no longer exists, in
  an owner-only `NO FORCE` window over the authorities and both credential
  tables (an owner bound by the credential tables' policies would see no
  credential and revoke every live authority), asserting convergence inside
  the window. Retained authorities of offboarded members are not touched.
  The repair's predicate (an active authority with no credential at its
  resource id) also matches authorities whose credential went with a deleted
  workspace: the credentials' workspace foreign keys cascade, while the
  authority's origin-workspace key only sets NULL and no delete trigger
  revokes it. Revoking those is also correct (without a credential there is
  no access), but 0717 fixes only the disconnect path, so such authorities
  reappear after every workspace deletion until a later migration revokes
  them on credential deletion; the inventory reports both kinds together.
- **Lock order.** Sections 5 and 6 lock `organization_memberships`, both
  personal credential tables and `organization_user_resource_authorities`,
  and the trigger swap locks `session_turns`. Runtime work reads memberships
  before turns (private-session visibility) and turns before memberships
  (the turn enqueue, then the v2 writer), so no order of the five is
  cycle-free; a reviewer reproduced `40P01` against the first draft, which
  held the membership lock while it waited for `session_turns`. 0717 takes
  the whole set first with 0716's bounded, retried lock acquisition (100 ms
  per wait inside a savepoint, released and retried on timeout, `55P03`
  after 30 s), so it never holds one of these locks long while it waits.
  Splitting the trigger swap into its own migration was the alternative; the
  bounded acquisition keeps one migration and covers every order, including
  the credential and authority tables. The race test
  `migration-0717-authority-fences-lock-order.test.ts` covers both orders.
- **Inventory.** `docs/deployment.md`, "Subscription authority fences
  (0717)", holds one read-only query listing every existing row the new
  comparisons refuse or the repair revokes (finding, account, workspace,
  row), including live scheduled tasks whose Claude snapshot has no
  admissible subject, live runs whose accepted `user` SuperGrok or Claude
  authority has no live credential, and the authorities the repair revokes.
  The test stages each kind before 0717, runs the query there as an operator
  would, and asserts it lists exactly them; after 0717 the same query lists
  them less the repaired authorities.

Part 3 (migration 0726) fixes a defect found while testing part 2 under the
documented owner posture (finding below). The v2 writers
(`subscription_core_acceptance_authority_v2`,
`subscription_core_task_authority_v2` and their Codex forms) count the
owner's personal connection generations holding only an account `lifecycle`
capability, which no `subscription_connections` policy honours for personal
rows. Choices:

- **The read, not the rule.** Each writer sets the owner-only
  membership-lifecycle marker immediately before its count and restores the
  caller's value right after it, as `subscription_personal_entry_serviceable`
  does (0717). The marker exposes rows only to the owner, the count is still
  restricted to the accepting owner's own personal connections at their
  active authority, and every other check is unchanged.
- **No new policy.** A `lifecycle`-capability read policy on
  `subscription_connections` would also widen what every other owner routine
  holding that capability sees; the marker is confined to these four counts.
- **No backfill.** Values frozen empty stay empty: a backfill would widen
  accepted work after the fact. New turns in a private session pick up the
  personal entry; scheduled tasks keep the value frozen at creation.
- **Health recovery too.** `recover_subscription_core_connection_health`
  (0707, 0715) and `recover_subscription_codex_connection_health` (0669)
  select the due quarantined rows the accepted turn could lease and had the
  same blind spot: a quarantined personal account was never recovered, even
  for the owner's own turn with the entry frozen (found in review of part 3).
  Each now collects its candidates into an array under the marker, restores
  the caller's value, then updates: the marker also enables the
  membership-lifecycle delete policy, so it is never set while the routine
  writes, and a lazily read cursor would have kept it set through the loop.
  The candidate filter is unchanged, so the marker widens nothing the routine
  returns: personal rows still need the turn's owner, the active owner
  membership and the frozen entry naming the row's membership and
  generation; shared rows still need the ordinary visibility rule.
  Follow-up, not changed here: the waiter's deadline lookup
  (`earliestHealthRetryAt`) reads as the application role and cannot see a
  quarantined personal row, so a waiter on a personal-only quarantine falls
  back to its 1 to 15 minute backoff instead of waking at the retry time.
  Recovery is delayed by at most one backoff interval, never skipped.
- **Personal connections allowed.** The writers read neither the
  organization's nor the workspace's `personalConnectionsAllowed`; placement
  applies the effective value for the session's workspace (the workspace's own
  value unless the organization has locked the setting, otherwise the
  organization's). The
  runbook's inventory therefore lists owners whose new acceptances will
  freeze the personal entry, not owners whose work will run on it.

#### PR 0c: provider-keyed cutover planner and organization reach

PR 0c is the slice of PR 0 that makes the M3 cutover planner rules and the
organization-reach machinery provider-keyed (everything "Not taken by M4-A"
above except 0691's operation kinds and the Codex scope-visibility helpers,
which the shared core does not call). Rolling migration 0713. Codex
behaviour is unchanged, and every Codex-named routine keeps its name,
signature, owner, grants and texts for the binaries that still call it, and
its security mode and search path too except 0689's plan-change trigger
function (below). Nothing is renamed, detached or dropped. A later SuperGrok
or Claude cutover calls these with its provider as data and needs no
routine of its own:

| Need | Provider-keyed entry point | Codex entry point kept |
| --- | --- | --- |
| Cutover plan | `planSubscriptionCoreCutover(rules, input)` with `SubscriptionCutoverRules` (`packages/db/src/subscription-core/cutover-plan.ts`) | `planCodexCutover(input)`: the same call with `CODEX_CUTOVER_RULES` |
| Reach rows for workspaces created later | owner-only view `opengeni_private.subscription_core_auto_assignments` over `subscription_codex_auto_assignments`, which gains `provider` keyed by the registry | the table keeps its name until retirement, when it takes the view's |
| Applying reach to a new shared or Personal workspace | `opengeni_subscription_internal.apply_subscription_core_auto_assignments(provider, account, workspace, personal)`, run for every provider by 0689's two trigger functions | `opengeni_private.apply_subscription_codex_auto_assignments` delegates with `codex` |
| Plan-change history | owner-only table `opengeni_private.subscription_core_plan_change_providers` (only `codex`) | 0689's `record_subscription_codex_plan_change()`, redefined in place to test it, still attached |
| Reading and setting reach | `opengeni_private.subscription_core_reach(provider, account, connection)`, `opengeni_private.set_subscription_core_reach(provider, account, connection, shared, personal)` | the 0702 pair, its own checks first, then the neutral routine |
| Organization workspace inventory | `list_organization_subscription_workspace_ids(account)` | `list_organization_codex_workspace_ids` unchanged |
| Capacity wake | `wakeSubscriptionCoreCapacityWaiters(db, provider, input, enqueue)` (`subscription-core/waiters.ts`) | `wakeSubscriptionCoreCodexCapacityWaiters` wraps it |
| Access editor | `getSubscriptionCoreModelConnectionAccess` / `updateSubscriptionCoreModelConnectionAccess(db, provider, ...)` (`subscription-core/access-editor.ts`) | the Codex pair wraps them |

The TypeScript entry points are internal to `packages/db`, as §5.1.3
requires: the package index exports only the Codex wrappers, and a later
provider's binding imports the neutral functions from their modules.

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
- **Reach rows keyed by provider, in place.** The table keeps its name,
  rows, owner-only grants, RLS mode and 0689's `(account_id, connection_id)`
  key to the connection, and gains `provider` (NOT NULL, `DEFAULT 'codex'`),
  keyed by the registry, so a row of an unregistered provider cannot exist.
  Every existing row was written for a Codex connection (0689's cutover and
  0702's Codex helper write no other), so the default fills the column with
  `codex`. The default stays until the retirement migration: an older
  binary's 0702 reach write (an access editor save or an allocator refresh)
  that waits for 0713's lock is planned again after the commit, against the
  new table, and names no provider, so without the default it would fail
  with 23502 (lock-order test). It cannot mislabel a row: only owner
  routines write the table, 0702's body writes only after checking the
  connection is Codex, and every 0713 routine names the provider (the
  second-provider test checks each stored row against its connection's
  provider). The one writer from 0713 on,
  `set_subscription_core_reach`, accepts only its provider's own
  connection. A key from `(account_id, provider, connection_id)` to the
  connection's `(account_id, provider, id)` would lock
  `subscription_connections` (see "Lock set and order"), so it comes with
  the provider-free name at retirement. No FORCE-RLS backfill runs, so there
  is no NO FORCE window. The registry stays untruncatable: a plain TRUNCATE
  is refused by the keys that reference it, and TRUNCATE ... CASCADE by its
  append-only guard.
- **A provider-free name without a rename.** The neutral routines reach the
  rows through the owner-only view `subscription_core_auto_assignments`
  (every column, no filter). Renaming the table would take no other lock,
  but a statement that waits for 0713's lock looks its relation up by name
  again once it has the lock: an older binary's workspace creation or reach
  edit waiting on the table across 0713's commit would then fail with
  42P01. Under its kept name it completes, with the reach it had before
  (lock-order test). The retirement migration drops the view and gives the
  table its name, so the neutral routines need no change then. 0713 changes
  nothing else such a statement relies on: it renames, drops and tightens
  no existing column, constraint or routine signature, its other objects
  are new names, a call already running keeps the routine body it started
  with, and the one new column carries the default above.
- **One apply path.** 0689's apply body with the provider as data, in
  `opengeni_subscription_internal` (owner-only routines stay out of
  `opengeni_private`, whose unknown routines a previous binary's readiness
  rejects). 0689's trigger functions `auto_assign_subscription_codex_workspace`
  and `auto_assign_subscription_codex_personal_workspace` are redefined in
  place (same owner, grants, security mode and search path) and stay
  attached to 0689's triggers `workspaces_subscription_codex_auto_assign`
  and `organization_memberships_subscription_codex_auto_assign`; they apply
  the reach of every provider with rows in the organization, in provider
  order. 0689's owner-only policies on both assignment tables already admit
  these writes for the organization named by their setting
  `opengeni.subscription_codex_auto_assign` (an organization, not a
  provider), so there is no new trigger, policy or setting. The callers
  (those two trigger functions and the Codex apply routine) set that
  setting around each call and restore the caller's value after it, as
  0689's apply routine did around its writes (a test reads it back in the
  caller's transaction), so the neutral apply path names no provider (the
  neutral-routine source check of 0707 covers it); without the setting its
  writes are refused.
- **Plan-change history by table.** The owner-only table
  `subscription_core_plan_change_providers` (only `codex`, keyed by the
  registry) replaces the provider test in 0689's trigger function, which is
  redefined in place and stays attached to 0689's `BEFORE UPDATE OF
  plan_type` trigger. It now reads owner data, so it runs as its owner
  (`SECURITY DEFINER`, search path pinned with `pg_temp` last; 0689's was
  invoker) and still only edits `NEW`. Codex records the same keys as before.
  A registry column would have locked the registry ACCESS EXCLUSIVE, which
  runtime transactions read after the workspace prefix.
- **Lock set and order.** Runtime transactions take the workspace prefix
  first and the subscription tables after it, and workspace or
  Personal-workspace creation holds its new row while 0689's trigger reads
  the reach table. 0713 therefore locks owner data only, first and in this
  order: the reach table ACCESS EXCLUSIVE (touched only by 0689's triggers,
  0702's helpers and the referential cascades from deleting a subscription
  connection or an organization, which wait for 0713 briefly), then the
  registry SHARE ROW EXCLUSIVE, which conflicts
  with no runtime lock (runtime roles only read it or check keys against
  it). It locks no workspace, membership, connection or assignment table:
  every other statement acts on those two tables, creates a table or a
  view, or creates or replaces a routine.
  While it waits for its first lock it holds nothing, and afterwards it
  waits for no lock a runtime transaction holds, so it cannot close a lock
  cycle with runtime work (the 40P01 shape 0299 fixed). Replacing the
  triggers or policies or adding the connection key would lock hot tables
  and wait for runtime work, so those come with the maintenance retirement
  migration. `migration-0713-provider-keyed-reach-lock-order.test.ts` races
  0713 against those runtime shapes as the application role.
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
- **Neutral entry points stay internal and guarded.** The
  provider-parameterized TypeScript entry points (the planner, the capacity
  wake and the access editor pair) live in shared modules under
  `packages/db/src/subscription-core/`, which the neutrality guard scans,
  and the package index exports none of them (§5.1.3). The access editor
  module also owns what the legacy editor shares with it: the policy shape
  `ModelConnectionAccess`, its two errors and the route scope
  (`withModelConnectionAccessScope`). `model-connection-access.ts` keeps the
  legacy connection kinds and the Codex pair, imports those, and re-exports
  the shape and errors under their existing names, so the modules form no
  import cycle and the package's exports are unchanged.
- **Rolling posture.** On a provisioned database without 0713, the previous
  release's evaluator, run as the runtime role, reports nothing missing
  before 0713, after it and after provisioning again; the new evaluator
  reports exactly the four new routines before 0713 and nothing after it.
  The migration grants the three runtime routines to the application roles,
  PUBLIC holds none of the four, and provisioning again leaves those grants
  as the migration set them.
- **Kept until retirement.** The Codex-named reach pair and apply routine
  are dropped with the other Codex-named routines (§5.1.2, "Rolling
  compatibility and retirement"). The same maintenance migration replaces
  the reach view with the table under that name, gives 0689's two
  auto-assignment triggers and their functions, the plan-change trigger and
  its function, 0689's `*_codex_auto_assign` policies and their setting
  provider-free names, adds the reach rows' connection-and-provider key and
  drops their Codex default; none of that can run while a rolling migration
  must stay off the workspace, membership and connection tables and keep
  the names and defaults older binaries use.
  R (0744) does this; see "R: retirement of the legacy pool routines and the
  Codex twins".
  `list_organization_codex_workspace_ids`
  stays while the legacy SuperGrok and Claude organization wakes call it
  (until X4 and C4; R keeps it because the legacy organization pool wake
  still calls it on its base). The Codex scope-visibility helpers stay as well. Most
  of their callers are legacy (the credential-table policies of 0381 and
  0423, 0492's legacy Codex source check) and are left as they are, but
  0424's access-update guard on the API-key connection tables
  (`organization_model_provider_connections` and `connections`) and its
  `model_connection_workspace_access` read policy on
  `organization_model_provider_connections` also call
  `codex_organization_admin_visible`. Generalizing those uses belongs with
  the API-key connectors.
- **Migration tests.** Tests that withhold 0689 also withhold 0713, which
  alters objects 0689 creates, and replay it after 0689; the neutral-routine
  test replays 0707, 0712, 0713, 0714 and 0715 together.

#### API-key connectors on the shared core

Step F proves that an API-key connector (OpenRouter, Vercel AI Gateway) joins
the shared core with an adapter and data only. A test-only connector,
`conformance_api_key`, passes the same conformance suite as the registered
Codex binding on real PostgreSQL as `opengeni_app`
(`packages/db/test/subscription-core-fake-api-key-conformance-postgres.test.ts`
and `subscription-core-codex-conformance-postgres.test.ts`). It is registered
only inside that test process and test database.

What a real connector implements:

- the adapter (`SubscriptionCoreAdapter`): `credentialKind: "api_key"`,
  `quotaKind` `spend_budget` or `rate_limits`, `refresh: null`; capabilities
  with `autoRenews`, `quotaWindows` and `extraCredits` false, the same for its
  one credential format through `capabilitiesFor`; `credential.decode`,
  `encode`, `expiry` (null) and `format` for its stored secret (for example
  `{ apiKey }`); `health` durations (forbidden quarantine, entitlement
  cooldown, and the fallbacks `rateLimitFallbackMs` and `exhaustedFallbackMs`
  for a refusal that names no time), `cacheFacts`, `modelPolicyProviderId`
  and `reloginText`;
- the database binding: `settings.primaryColumn: null` (no primary
  connection: the shared setter refuses with
  `subscription_core_primary_unsupported`), no compaction lock, the default
  errors, no allocator hook;
- outside the binding, in the connector's step: a sign-in that validates the
  pasted key upstream and returns its identity (below); a transport with
  request-local bearer authorization; `classifyError` into the shared
  outcomes, reading the response body as well as the status, and never
  the HTTP client's error class (Vercel warns that its AI SDK can surface a
  budget 402 as `GatewayInternalServerError`, which would read as
  `transient`). OpenRouter reports a failure after the provider accepted
  the request inside a 200; the transport raises it and the classifier
  maps it to the status it stands for. On Chat Completions that failure is
  a body holding only an `error` object, an SSE error event with
  `finish_reason: "error"`, or an error in `choices[].error` next to
  partial output, each with the HTTP status in `error.code`. On Responses
  `error.code` is a text code such as `server_error`, and Messages has no
  `code`, so there the classifier derives the status from `error_type`.
  Responses' `response.error` and `error` stream events carry only a text
  code (such as `rate_limit_exceeded`) and no `error_type`; the classifier
  maps an unambiguous code to its status, leaves any other unclassified,
  and the connector confirms these events against live traffic.
  `error_type` is read where the connector's API puts it (`error.metadata`
  for Chat Completions, the top level for Responses, `error` for Messages).
  The mapping:
  - 429 to `rate_limited(retryAfter)`.
  - A spent key, budget or credit limit to `exhausted(resetAt)`:
    - OpenRouter: a 403 whose `error.metadata.limit_source` is
      `openrouter_key_limit`, `openrouter_workspace_budget` or
      `openrouter_guardrail_budget`, with `resets_at` (an ISO 8601 string;
      null for a lifetime limit) parsed as the reset.
    - OpenRouter: a 402 for `openrouter_key_limit`, or for a balance that
      cannot cover the request (`limit_source: openrouter_credits` without
      `reason: weight_exceeds_budget`; only `reason` tells the two
      `openrouter_credits` cases apart), with no reset in the body (the
      key's `limit_reset` from `GET /api/v1/key` names only a period).
    - Vercel AI Gateway: a 402 with `error.type: quota_for_entity_exceeded`
      and no reset in the body, or the budget's refresh boundary (midnight
      UTC, Monday, the 1st, or never) when the connector knows which budget
      refused.
  - OpenRouter's 402 for a full in-flight budget
    (`limit_source: openrouter_in_flight_budget`) to `rate_limited` with its
    `Retry-After` delay: it is transient.
  - OpenRouter's 402 for one request too expensive for the whole budget
    (`reason: weight_exceeds_budget`) to `fatal`: retrying cannot help and
    smaller requests still fit.
  - 401 to `unauthorized`.
  - A block of the one request to `fatal`, which neither fails over nor
    changes health. For OpenRouter that is a 403 with no `limit_source` that
    carries a guardrail's `error.metadata.patterns`, a moderation flag's
    `reasons`, or `error_type` `content_policy_violation` or `refusal`.
  - Only a refusal of the key itself to `forbidden`, such as OpenRouter's
    data-region restriction or Vercel AI Gateway's
    `customer_verification_required` 403 (the team must add a payment
    method). Some OpenRouter 403s do not say which they are:
    `error_type` `permission_denied` covers both a key without the
    permission and a guardrail block (on Messages either arrives as a
    `permission_error` envelope), and a content-filter block such as
    `Request blocked by content filter: …` has the same shape as the
    data-region refusal. The connector opts in to router metadata
    (`X-OpenRouter-Metadata: enabled`; OpenRouter still accepts the legacy
    `X-OpenRouter-Experimental-Metadata` its errors reference shows) and
    treats a 403 whose `openrouter_metadata.pipeline` holds a
    `guardrail` stage as a block of the one request (`fatal`), and it
    confirms the remaining shapes against live traffic before it ships. The
    fake connector does not model router metadata, so it reads both as
    `forbidden`.
  - A model the key cannot use to `entitlement_missing(model)`. For
    OpenRouter that includes a guardrail allowlist 403, whose body OpenRouter
    does not publish, so the connector confirms it against live traffic
    before it ships. For Vercel AI Gateway it includes a model or provider
    allowlist 403 (`type: no_providers_available`, whose message is the
    top-level `error` string rather than `error.message` as in a budget
    402) and a 403 whose message names the free tier (the model is outside
    the free-tier subset; Vercel publishes no body for it). The Vercel
    connector confirms its 403 shapes against live traffic before it ships.
    The OpenRouter connector reads its live catalog from
    `GET /api/v1/models/user`, which is already filtered by the key's
    guardrails, so while that read is fresh the core's observed-catalog
    entitlement places no model outside the allowlist. A stale, missing or
    failed read does not restrict placement (section 9, "Catalog
    observations and selection corrections"), and a guardrail can change
    after the last read, so this 403 can still occur.
  - A limit on one model to `rate_limited` or `exhausted` with that
    `modelId`.
  - A busy upstream to `overloaded`, and a server error to `transient`.
  - Null for what it cannot classify, such as a lost connection.

  The step also adds a usage reading into the shared quota model, and the
  key's live model catalog (upstream ids of any number of vendors).

What it stores: `subscription_connections` rows with `kind = 'api_key'`, the
encrypted secret in `credential_encrypted`, `expires_at` NULL and its own
`provider_state`. A spend budget is one usage window (`id: "spend_budget"`,
`usedPercent` = spent / limit, `resetsAt` = end of the budget period or
null). Refusals are recorded by the shared settlement step (decision 5): a
rate limit is `exhaustedUntil` = now + retry delay (`exhaustedKind:
"rate_limit"`, `rateLimitFallbackMs` when the upstream gives none); an
exhausted budget with a known reset is `exhaustedUntil` = reset (`"quota"`,
authoritative); one without a known reset is an exhausted window
(`exhausted_without_reset`) that resets after `exhaustedFallbackMs`, so
placement retries the key then even without a usage reading, and a usage
reading that shows capacity replaces it sooner (a reading never shortens an
`exhaustedUntil`); a limit on one model is that model's cooldown on the
connection. Its step's
migration inserts the registry row (`connection_kind = 'api_key'`,
`primary_setting_column` NULL, `extra_credits` false) and the cutover receipt
(PR 0), and adds the provider id to the provider lists that still enumerate
providers: the CHECK constraints whose `ARRAY[...]` lists end in `'xai'` and
`subscription_personal_authority_v2_valid` (the harness function
`admitTestSubscriptionCoreProvider` performs and returns exactly this list).
It also extends the provider-to-attribute mapping that emits `model.connected`
on a core connection insert (`capture_product_lifecycle_fact`, 0712 part 6,
which lists only `codex`, `xai` and `claude`) with the provider id and its
legacy attribute (`openrouter`, `vercel_gateway`); without it a connector
moved onto the core silently stops a lifecycle fact the legacy table emits
today. The test harness admits no lifecycle mapping, since the conformance
suite does not capture lifecycle facts.
In TypeScript it adds the binding to `subscription-core-providers.ts` and the
id to `SubscriptionPersonalAuthorityV2`.

What the core does, unchanged: connect, reconnect and disconnect through the
shared writers; organization access and reach through the shared access
editor and `set_subscription_core_reach`, with a new workspace assigned from
the reach row; placement with shared scopes, ownerless sessions shared-only,
personal connections only for the owner's private session or Personal
workspace with the exact frozen owner membership and current authority
generation, and spread; generation-fenced leases; per-lease credential load;
request reservation and settlement, with an unknown outcome never replayed;
the refusal count that bounds failover; quota observations, and a durable wait
at the earliest reset of rate limits and budgets, its wake outbox and resume;
forbidden quarantine and recovery; model cooldowns; observed-catalog
entitlement; no failover and no health change for an overloaded, failed or
lost request (a lost one blocks every later request of the turn). A refused
key becomes `needs_relogin` at once (a sign-in quarantine), because the core
never refreshes a credential whose format does not renew; a renewable
credential is refreshed once and retried on the same connection first.

Decisions:

1. Connection kind is registry data. `subscription_core_providers` gains an
   immutable `connection_kind` (`subscription` default, or `api_key`); the
   sixteen neutral routines that named a kind (fourteen from 0707 and the
   organization reach setter and reach allocator setter as 0714 defines
   them), plus the two personal reads
   that did not (personal management's target lookup and the personal
   connect's authority generation), read it through the owner-only
   `subscription_core_connection_kind(provider)` (0715, rewritten from their
   live definitions by anchored replacement; the neutral-routines test pins
   each routine's count of registered-kind reads), and the TypeScript writers
   derive it from the adapter's `credentialKind`
   (`subscriptionCoreConnectionKind`). A binding-gate test requires the two to
   agree. Core placement, the serving catalog, a wait's health-retry read
   and the organization access editor read only the registered kind, so a
   row of the other kind is never placed for the provider. A
   connection kind is never a provider branch, and no shared code names
   one: the neutrality guard refuses a kind literal in the shared TypeScript
   modules outside comments, union types and the credential-kind mapping
   (§5.1.3 Guard), and the neutral-routines test
   refuses a `'subscription'` or `'api_key'` literal in any database routine
   named `subscription_core`, so a later neutral routine reads the
   registered kind too. Because the kind belongs to
   the provider, a vendor that offers both a subscription and API keys
   registers two provider ids, one per kind. Because 0715 rewrites routines
   0707, 0713 and 0714 create, migration tests that hold back any of them
   hold back 0715 too and replay it after them.
2. Identity of a key. A key names no upstream account or person, but the
   shared connect needs both to tell connections apart and refuses without
   them (`identity_unverified`, unchanged). The connector's sign-in derives a
   stable synthetic identity only after the upstream accepted the key, never
   from caller input: `provider_account_id = provider_subject_id =
   key-hmac:<first 32 hex digits of HMAC-SHA256(deployment secret, key)>`,
   keyed with a stable server-side secret (as the Claude subscription
   fingerprints are), so a stored value neither confirms a guessed key
   offline nor correlates tenants across deployments; changing the scheme
   later re-keys identities and breaks reconnect-in-place, so it is fixed
   before a real connector stores any. Re-adding a key reconnects in place, a
   new key is a new connection, and the key never appears in identity
   columns. A connector whose upstream reports a stable account or key id
   may use it as `provider_account_id` and keep the keyed fingerprint as the
   subject id. Open: replacing a rotated or revoked key in place (keeping
   the connection's label, scope, people, allowlist and allocator state)
   needs a credential-replace writer; today a new key is a new connection and
   the old one stays `needs_relogin` until removed.
3. No primary connection for API-key connectors (`primary_setting_column`
   NULL); spread and allowlists apply.
4. Cross-provider failover between an API-key connection and a subscription
   is a placement-policy decision (`decidePlacement` with
   `crossProviderFailover`), which the suite checks against the reference
   model in both directions. Core placement leases from one provider per turn
   (§5.1.3); its cross-provider step is not part of M4.
5. Refusal settlement is shared: `planSubscriptionCoreRefusal`
   (`@opengeni/subscriptions`, pure) maps a classified outcome to the request
   ledger outcome and one plan, and `subscriptionCoreSettlement`
   (`packages/db/src/subscription-core/settlement.ts`) applies it through the
   core's fenced writers: the failure receipt first (it counts toward the
   failover bound and carries the refused credential's refresh generation),
   then the quota observation, model cooldown or quarantine. Unauthorized and
   forbidden refusals of a renewable credential are refreshed once and
   retried on the same connection; only a refusal that survives is settled.
   An overloaded, failed or unclassified reply is never a refusal. The suite
   settles every outcome through this step. The live Codex worker still
   settles through its own Codex-named code
   (`apps/worker/src/activities/agent-turn/codex-core-settlement.ts`) and
   adopts this step with the shared worker settlement (SuperGrok and Claude
   steps). Until then it differs in: Codex failure-kind names (`quota`,
   `rate_limit`, `auth`, `forbidden`, `plan_entitlement`) in receipts; the
   Codex credit-policy (`usage_verification_policy`) branch; an exhaustion
   whose reset is unknown rests as `exhaustedUntil` = now + 5 hours (the
   shared step uses a fallback window that a usage reading can clear);
   refresh happens in the worker's own seam before classification; and its
   writes are best effort. Codex's `rateLimitFallbackMs` and
   `exhaustedFallbackMs` equal the worker's 60 seconds and 5 hours.
   The credit-policy branch records its refusals as `refusal` observations
   (§2.2): `usage_verification_policy` as no windows with a 60-second
   `rate_limit` deadline, `included_usage_policy` as one exhausted
   `included_usage` window until now + max(60 s, the policy's cooldown). Like
   any refusal they keep a stored exhausted window with a known future
   reset (a weekly `secondary` window days away, say), so the connection
   keeps waiting for it after the 60-second hold; before, they were tagged
   `usage_endpoint` and erased it. Codex header readings report only
   `primary` and `secondary` (the credit guard's own `/wham/usage` reads
   reach the store as header readings through finalization too), so a
   header reading no longer ends the `included_usage` hold: it ends at its
   reset or with a real usage reading (`fetchSubscriptionCoreCodexUsage`),
   which replaces every window. Both only wait longer, and the credit guard
   would refuse again before dispatch anyway. Legacy set this hold to
   min(the policy's reset, now + 60 s) (`includedUsageUnavailableUntil`)
   and only time ended it. So the core waits longer than legacy, except
   that a usage reading in the first 60 seconds ends the hold earlier than
   legacy did: the connection is placeable again (the reading's wake reaches
   waiters), and the credit guard re-reads usage and refuses again before
   dispatch, at the cost of one refused admission. A reset-credit redemption
   ends only `exhaustedUntil`, so an exhausted window kept through a
   credit-policy refusal still blocks after it until its reset or the next
   usage reading, as any stored exhausted window already did.
6. A connector not registered in production is registered for tests only:
   `testSubscriptionCoreProviderModules(binding)` returns the replacement
   TypeScript registry and v2 provider-list modules, which the test file
   installs with `mock.module` before importing the suite (so the CI shard
   classifier runs that file in its own process), and
   `admitTestSubscriptionCoreProvider` widens the test database only.

Found by the suite and fixed in PR 0: the personal-access helper (0668) and
the operation-lease kind CHECK (0691) admitted personal leases and model
request reservations for Codex only, so any other provider's personal turns
and requests were refused. Still provider-specific or open, and owned by later
steps: the worker settlement (decision 5) and capacity-wait wrappers;
per-model `cacheFacts` and `modelPolicyProviderId` for a connector serving
several vendors (one per adapter today); the effective-settings primary
mapping; a turn credential source for an API-key connector on the core
(`ModelCredentialSourceV1`'s `connected_subscription` lists only `codex`,
`xai` and `claude`; the suite freezes `organization_connection` /
`api_key`, the existing organization-key source); the in-place key
replacement of decision 2; and the stored `credential_format`, which the
shared connect writers (TypeScript and the 0707 personal connect) still set
to `v1` for every provider (PR 0a's note above), so the core reads a
credential's format from the decoded credential (`credential.format`), never
from that column.

Running the suite for another adapter: call
`describeSubscriptionCoreConformance(subject)` from
`packages/db/test/helpers/subscription-core-conformance.ts` in a new
`*-postgres.test.ts`. The subject gives the binding, at least three models,
a credential per label, the sign-in identity, provider state, expiry, the
frozen execution policy's credential source and billing, a foreign provider
id its database admits, a scripted upstream
(`SubscriptionCoreConformanceUpstream`: it renders the suite's
`ScriptedReply` vocabulary in the provider's wire format and supplies the
connector's transport, classifier and optional usage reading) and the
network-denial guard. A renewable provider's binding is built with a
scripted refresher (the Codex subject rotates tokens locally), which the
suite's refresh-and-retry test drives. A registered provider passes its
binding; an unregistered one installs `testSubscriptionCoreProviderModules`
with `mock.module` in its test file before importing the suite, and calls
`admitTestSubscriptionCoreProvider` in `prepareDatabase`. Every organization
the suite creates also holds a healthy and a quarantined, exhausted
connection of the foreign provider with the subject's connection kind, and
two healthy rows of the subject's provider with the other kind; no read,
lease, wait, recovery, administration, access edit or reach change of the
subject's provider may touch either (the access test also calls the reach
routine directly for each, which must refuse, and edits a workspace's own
connection through the workspace route, which must not read that
workspace's row of the other kind). The connect and administration tests add the owner's personal
connection of the foreign provider (authority generation 2) and of the
subject's provider with the other kind (generation 7); personal lists,
management, disconnects, frozen authority and new personal connections'
generation must ignore both. The recovery test quarantines an other-kind row,
first until sooner than this kind's quarantine (the wait's retry time must
ignore it, and a current model catalog on the other other-kind row that
expires sooner still) and then due (recovery must leave it alone). Reset and retry times
are compared as exact instants. Run each file in its own
process from `packages/db` with
`OPENGENI_TEST_PG_NATIVE=1 OPENGENI_REQUIRE_REAL_DB=1 bun test ./test/<file>`.
The network-denial guard refuses `fetch` and `node:http`/`node:https`
requests made through the module objects to any origin but the scripted
upstream; named ESM imports of those functions, `node:net`/`node:tls`
sockets (PostgreSQL uses them), `Bun.connect` and `WebSocket` are not
intercepted, so a connector's transport must use `fetch` or the module
objects. The suite does not cover streaming replies, malformed responses,
delays or a provider's real wire classifier and usage decoder, nor the
out-of-turn connection refresh or the serving catalog beyond its exclusion of
other-kind rows; each provider step tests those for its own connector. It arms and
wakes the durable waiter through the shared waiter repository with the
earliest reset the placement returned, and loads credentials through the
core's lease-checked load; the arming wrapper and the turn credential
resolver a live turn calls are still Codex-named and are exercised by the
Codex suites, and move to the shared path with the worker settlement
(decision 5). For Codex the suite therefore checks the shared settlement
step, not the worker's own settlement that live Codex turns use today.

#### SuperGrok track

The SuperGrok steps land dormant: every new call site reads
`readSubscriptionCoreProviderRoute(db, {accountId, provider: "xai"})` first.
`legacy` (no `xai` cutover receipt) runs the existing SuperGrok path
unchanged, at the cost of that one receipt read; `maintenance` fails closed
with `subscription_core_cutover_disabled`; `core` runs the shared runtime.
The SuperGrok binding stays out of the provider registry until X3 adds its
SQL registry row, so a `core` answer before then still fails closed.

##### X1a: adapter and chat placement

Generalized (Codex keeps every export, error class, code and text, metric
name and label, and event shape; its names are thin bindings of the shared
code):

| Codex-named (M3) | Provider-neutral |
| --- | --- |
| `createCoreCodexRequests`, `providerRequestIdPrefix` (`codex-core-requests.ts`) | `createCoreSubscriptionRequests`, `providerRequestIdPrefix` (`subscription-core-requests.ts`) |
| `CodexTurnLease` renewal, dispatch fence and release | `CoreSubscriptionTurnLease` (provider id, display name, TTL, optional legacy heartbeat); `CodexTurnLease` and `XaiTurnLease` extend it |
| `selectCoreCodexTurnCapacity` placement, adoption and compaction defer | `selectCoreSubscriptionTurnCapacity` with a `CoreTurnPlacementProvider` (`subscription-core-capacity.ts`); Codex keeps its entitlement refresh, selection receipt and park as hooks |
| the source and lease guard of `buildCoreCodexRequestTokenResolver` | `guardCoreTokenResolver`, `coreLeaseRef`, `assertCoreSourceConnected` |
| between-call revalidation in `stream-attempt.ts` | `revalidatePlacedSubscriptionCore` (`subscription-core-placed.ts`) |
| `CodexSubscriptionCoreTurn` | `SubscriptionCoreTurn` (alias kept); `subscriptionCoreTurnOf(providerTurn)` for checkpoints and `model_call_facts.connection_id` attribution |
| `codexCredentialLeaseHolderId` | `subscriptionTurnLeaseHolderId(provider, displayName, input, turnId)` |
| failure copy builders in `codex-core-errors.ts` | the same builders with an optional display name (default `Codex`, so texts are unchanged) |
| `subscriptionCoreAcceptedCodexTurnIsFunded` behind `isCodexBilledTurn` | `readSubscriptionCoreRouteFunding` (`subscription-core/route-readiness.ts`) and `coreRoutedSubscriptionFunding` in the `@opengeni/core` limits; `isCodexBilledTurn` is unchanged |
| the Codex turn bearer resolver | `buildSubscriptionCoreTurnTokenResolver` (`subscription-core/turn-token-resolver.ts`); Codex keeps its own binding |

The package index now exports, for the worker and `@opengeni/core`,
`subscriptionCoreTurns`, `subscriptionCoreRequests`, the catalog functions,
`SubscriptionCoreError`, the `SubscriptionCoreProvider` type,
`buildSubscriptionCoreTurnTokenResolver`, the route helpers
(`readSubscriptionCoreProviderRoute`,
`readSubscriptionCoreProviderRouteForWorkspace`) and route answers
(`readSubscriptionCoreRouteFunding`, `readSubscriptionCoreRouteReadiness`),
and the SuperGrok adapter and resolver. This supersedes §5.1.3's "the
package index exports none of the provider-parameterized entry points".

SuperGrok on the core:

- Capacity: `selectXaiTurnCapacityByRoute`. On `core`, placement under the
  turn's accepted identity and attempt fence with the `xai` binding; the
  core lease (`subscription_leases`, provider `xai`) is renewed, fenced and
  released by `XaiTurnLease`, which keeps its legacy heartbeat by subject on
  the legacy route. The legacy pre-selection quota refresh does not run.
- Materialization and refresh: the shared credential resolver under the
  exact accepted turn and this attempt's lease; `userId` is the
  connection's `provider_account_id` (a connection without one needs a new
  sign-in).
- Request custody: `@opengeni/xai-subscription` gains
  `beforeProviderDispatch` and `onProviderRequestSettled`. Each physical
  request (each transport attempt, including the refreshed retry after a
  401; a hosted-search continuation is part of the same streamed request)
  is fenced and reserved before network I/O and settled once: `refused` for
  a definite HTTP refusal or an HTTP 200 capacity terminal before any
  output, `response_received` for a completed stream, `unknown` otherwise.
  Session-title requests use the turn's title custody lane.
- Readiness, `list_models` and funding: `loadCoreRoutedXaiCatalogReadiness`
  (readiness and the `supergrok/` restriction from the serving connections'
  allowlists) and `coreRoutedSubscriptionFunding` (the accepted turn's core
  funding, or a serving connection that admits the model).

Fail-closed choices:

- No core park until X1b: a core wait is a terminal capacity failure (a
  compaction turn is cancelled with its request preserved, as for Codex).
- An unknown outcome is terminal for the turn (Codex's bounded
  own-interruption recovery is not extended to SuperGrok). Lease-loss
  recovery on the core requires checkpointed, recoverable request lanes.
- A frozen legacy SuperGrok authority snapshot (scheduled work) does not
  select the core pool in catalog readiness; execution uses the accepted
  turn's core authority. Until X2b no SuperGrok acceptance writes v2, which
  reads as no personal authority.
- Image, video, transcription and realtime readiness stay on their legacy
  readers (X2a).
- A core-placed SuperGrok turn offers no image or video tool until X2a
  moves them onto core operation leases: the legacy media paths would read
  the subject's current v1 authority, the legacy pin and the legacy
  credential table with a core connection id, and image requests would
  dispatch without the per-request fence and reservation.
- Session-title custody on the core is required: a core turn without its
  title lane or request authorization throws instead of sending unreserved
  title requests.
- Core-routed admission funding is opt-in per provider and only while the
  provider is enabled on the deployment (SuperGrok here, matching its
  catalog readiness); Claude's entry is added by C1a (its call-site step),
  so no Claude admission reads a provider route before then.
- A source disconnect is recognised by its shared code
  (`subscription_core_source_disconnected`) for every provider, so a core
  SuperGrok disconnect joins the admitted title stream and propagates out of
  compaction exactly as a Codex one does.
- Follow-up (after the stacked SuperGrok and Claude worker PRs land, to
  avoid churn under them): move `CapacityPhaseDeps`, the failure payload and
  the neutral copy builders into provider-neutral worker modules and extend
  `check:subscription-core-neutral` to `apps/worker/.../subscription-core-*.ts`
  with `subscription-core-placed.ts` as the one allowed enumerator.
- The route is read when the turn's capacity phase runs, not at claim time:
  a turn claimed before the cutover and placed after it places on the core.

##### X1b: settlement, waits and wakes

X1b replaces the first two fail-closed choices above: a core wait parks the
same turn on a durable core waiter, and a definitive refusal re-places it.
An unknown request outcome stays terminal for SuperGrok (see below).

Generalized (Codex keeps every export, stage name, event, reason, metric name
and label; its names are thin bindings of the shared code):

| Codex-named (M3) | Provider-neutral |
| --- | --- |
| `failOverCoreCodexTurn`, `coreCodexFailoverDisposition`, `SUBSCRIPTION_CORE_CODEX_TURN_REFUSAL_LIMIT` (`codex-core-failover.ts`) | `failOverCoreSubscriptionTurn`, `coreFailoverDisposition`, `SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT` with a `CoreFailoverBinding` (display name, lease, refusal count, recovery reason and provider label, metrics) in `subscription-core-failover.ts` |
| `parkCoreCodexTurn` | `parkCoreSubscriptionTurn` (`subscription-core-capacity.ts`) |
| wake delivery, blocked-turn evaluation, health recovery with wake, and reconcile in `subscription-core-codex-waits.ts` | the same steps over a `CoreWaitBinding`: `wakeSubscriptionCoreWaitersAndDeliver`, `evaluateCoreBlockedTurn`, `recoverCoreHealthAndWake`, `reconcileCoreCapacityWait` |
| `armSubscriptionCoreCodexCapacityWait`, `reconcileSubscriptionCoreCodexCapacityWait` | `armSubscriptionCoreCapacityWait(db, provider, input)` and `reconcileSubscriptionCoreCapacityWait` (which uses the waiter's own provider), with one session-event vocabulary per provider |
| `wakeSubscriptionCoreCodexCapacityWaiters` | `wakeSubscriptionCoreProviderCapacityWaiters(db, provider, input)`, over the provider-neutral workspace enumeration (PR 0c) |
| `deleteSubscriptionCoreCodexWaitersForTurns` (file removed) | `deleteSubscriptionCoreWaitersForTurns(db, null, ...)`: Steer, Cancel and queue supersession remove a blocked turn's core waiter of any provider |
| the Codex-only `capacity_waiter` session classification and peek | `getSubscriptionCoreCapacityWaitForSession`, `getSubscriptionCoreCapacityWaitById` and `subscriptionCoreCapacityWaitRef` (any provider; the ref names `provider` only when it is not Codex, so Codex refs are unchanged) |
| the refusal step of `settleSubscriptionCoreOutcome` | `applySubscriptionCoreRefusal`, exported with `subscriptionCoreSettlement` |
| (new, no Codex counterpart: Codex keeps its M3 refusal kinds) | `settleCoreSubscriptionRefusal(deps, core, binding)` and `finalizeCoreSubscriptionTurn` with a `CoreRefusalBinding` (provider, display name, classifier, lease, disconnect check, failover binding) in `subscription-core-settlement.ts`; `subscriptionCoreFailoverMetrics(provider)` in `subscription-core-failover.ts`. The Claude track binds the same steps. |

SuperGrok on the core:

- Classification: `classifyXaiProviderError` maps a failed request to a
  shared `ProviderErrorOutcome` (relogin or marked 401 `unauthorized`,
  marked 403 `forbidden`, marked 429 or HTTP 200 capacity terminal
  `rate_limited` with the provider's retry time, or null so the binding's
  fallback applies). It holds the rules `classifyXaiCredentialFailure` had;
  the legacy function is now its view, with the same output. It sits next to
  the Codex classifier in the worker because it needs the worker's safety
  refusal and Retry-After parsing; the core binding has no classification
  hook (step F's adapters classify in their transport too).
- Settlement (`settleCoreSubscriptionRefusal` with `XAI_CORE_REFUSAL`): a
  refusal is recorded against the leased connection through
  `planSubscriptionCoreRefusal` and
  `applySubscriptionCoreRefusal` (failure receipt plus quota, cooldown or
  quarantine), fenced on the refresh generation the refused bearer carried.
  Only the conversation lane writes that generation, at its physical
  dispatch; the session-title lane resolves and refreshes through its own
  token functions, so a title refresh in flight never moves the main
  lane's refusal fence. The binding declares its credential
  (`CoreRefusalCredential`): renewable, and refreshed before refusal. The
  transport already refreshed and retried an unauthorized request once; a
  marked 403 is also settled as refreshed, which keeps the legacy SuperGrok
  behaviour (switch accounts and quarantine the connection for the forbidden
  window) instead of a refresh round trip the transport never makes for a
  403. The same turn then re-places within
  the shared per-turn bound (4 refusals): another account, or a durable
  wait. A graceful source disconnect re-places without a refusal or a
  count. A sign-in, forbidden or access-lost refusal that could not
  re-place (not recorded, or no durable checkpoint) fails the turn with
  typed SuperGrok copy and idles the session; a rate limit that could not
  re-place takes the generic provider-failure path. The legacy SuperGrok
  refusal settlement never runs for a core turn.
- Failover recovery reason `xai_credential_failover` with provider label
  `supergrok-subscription`; metrics
  `opengeni_subscription_core_failover_checkpoints_total` and
  `opengeni_subscription_core_failover_settlements_total` labelled
  `provider="xai"` (Codex keeps `opengeni_codex_failover_*` with
  `workspace_key`).
- Waits: the placement's wait parks the turn on a core waiter (provider
  `xai`). Its session events keep the legacy SuperGrok vocabulary
  (`turn.capacity_waiting` with `recovery: "provider_capacity"`,
  `turn.recovery.requested` with reason `xai_capacity_available`,
  `turn.superseded`; status reason `xai_capacity`), so clients and the
  workflow see one vocabulary across the cutover. A health recovery wakes
  the account's other SuperGrok waiters.
- New SuperGrok behaviour at the cutover: the core waiter brings the shared
  false-resumption breaker. A resumed turn that parks again without a
  completed model request with meaningful output counts one false
  resumption and backs off (30 seconds to 15 minutes, jittered); at 10 the
  turn fails with the new terminal code `xai_capacity_recovery_exhausted`
  (`recoveryExhausted: true`, which clients already render generically).
  The SuperGrok transport now reports `meaningfulOutput` on its `completed`
  request event (assistant text, a complete tool call or an image, the
  Codex rule), so a productive resume resets the breaker exactly as for
  Codex; the field is inert on the legacy route, whose turns never carry
  the breaker. Human Retry clears the breaker and the goal suppression for
  every core-waiter exhausted code (`SUBSCRIPTION_CORE_WAIT_EXHAUSTED_CODES`),
  not only Codex's. A stopped arm deletes the existing waiter by id, so no
  other provider's row is left behind.
- Workflow: no workflow code changes. The peek returns a core waiter first
  (with `provider: "xai"`, the shape the legacy SuperGrok peek already
  returns), and a reconcile with `provider: "xai"` looks the core waiter up
  by its exact id and generation before the legacy table, so a history
  that recorded a legacy reference reconciles against the waiter X3 moves
  with the same id and generation.
- Finalization: a completed conversation-lane model call moves the binding's
  cache clock before the core lease is released (a title request does not).
  The per-turn SuperGrok quota call runs
  only on the legacy route; on the core, quota is observed on refusal (and
  by X2a's billing re-read of exhausted shared connections, which runs
  before placement and before each reconcile of a parked SuperGrok core
  turn). A connection that re-read finds recovered wakes the SuperGrok core
  waiters through the same provider-neutral database wake as X1b's health
  recovery (`wakeSubscriptionCoreCapacityWaiters`); the generic session
  workflow wake committed with it reaches the waiter, so that wake does not
  depend on the typed signal being drained.
- Waits that can end before their reset: a SuperGrok billing read can end a
  quota exhaustion before its stored reset (the adapter's
  `usageReadEndsQuotaExhaustion`). Its core waiter therefore rechecks on the
  bounded control-plane backoff, 60 seconds doubling to 15 minutes and
  capped at the reset and at a sooner quarantine end
  (`reset_kind = bounded_refresh`). Its reconcile
  (`CoreWaitBinding.refreshBeforeReconcile`) re-reads billing for the
  workspace's exhausted shared connections and the personal connections
  placement's personal authorization admits before placement evaluates,
  under the parked turn's exact accepted identity
  (`readSubscriptionCoreTurnIdentity`, never a synthetic one; without it the
  evaluation revokes and nothing is read), as the legacy waiter re-read
  billing. Without this, a parked turn in a quiet
  organization would sleep until the end of the credit period after credits
  were back. The personal probe receives that exact identity as
  `personalTurn`; ownerless or shared-only accepted work cannot borrow a
  person's connection. Codex
  waiters are unchanged: they sleep until an authoritative reset. The waiter
  vocabulary's `recheckBeforeReset` mirrors the adapter flag, and the
  conformance suite checks that the two agree.
- Compaction: X1b adds no compaction change. A compaction turn whose
  placement waits is still cancelled with its request preserved (as for
  Codex) and never parks; a test asserts it arms no waiter.
- Follow-ups recorded, not in X1b: (1) Codex has the same shared-slot shape
  for its refusal fence (its title lane shares the tracked token functions).
  The imprecision is bounded and goes both ways: a newer generation can be
  quarantined or limited, or a rare race can fence the refusal on an older
  generation so its health record is dropped. The turn still fails over and
  authority is never widened. It is left for a Codex-owned change that gives
  Codex the SuperGrok shape, so this PR keeps Codex byte-for-byte. (2) Moving the waiter
  vocabulary into the provider registry and the wait steps out of the
  Codex-named module is a rename left until the Claude track has landed on
  these files.
- Unknown outcomes stay terminal. Codex's bounded own-interruption recovery
  is not extended to SuperGrok: the legacy path already refuses to replay
  an idle-timed-out stream or a stalled hosted-search continuation, because
  hosted tools run on the provider and a replay may repeat them.

##### X2a: media and probes

Every consumer reads the organization's SuperGrok route
(`readSubscriptionCoreProviderRouteForWorkspace`): `legacy` (no receipt)
keeps the legacy path unchanged, `maintenance` fails closed, `core` runs on
the shared runtime bound to `SUBSCRIPTION_CORE_XAI`, which stays unregistered
until X3. SuperGrok-specific code is the adapter's `fetchUsage`,
`decodeQuota`, `liveModels` and bearer mapping, and route wiring.

- **Replaces X1a's media gate.** X1a offered a core-placed SuperGrok turn no
  image or video tool. X2a gives it the core image path on its placed
  connection, and core video funding when the route is `core`. The legacy
  video credential reads still run only on the `legacy` route for a turn the
  core did not place, whatever the route reads later in the turn.
- **Generalized, Codex unchanged.** The Codex operation pieces became
  provider-neutral (`subscriptionCoreOperationConnections(provider)`), and
  the Codex names are thin wrappers over them:

  | Before | After |
  | --- | --- |
  | `listSubscriptionCoreCodexOperationCandidates` | `.listSubscriptionCoreOperationCandidates` |
  | `buildSubscriptionCoreCodexConnectionTokenResolver` | `.buildSubscriptionCoreConnectionTokenResolver` |
  | `fetchSubscriptionCoreCodexUsage`, `usageQuotaObservation` | adapter `fetchUsage` and `decodeQuota`, `.probeSubscriptionCoreConnectionUsage` |
  | Codex transcription helpers in `codex-subscription.ts` | shared helpers in `transcription/providers/subscription-core.ts`; SuperGrok runs on `transcribeOnSubscriptionCore`, Codex keeps its own lease loop over the shared helpers |
  | (new) | `.runSubscriptionCoreOperation`, `.probeSubscriptionCoreConnectionLiveModels`, `.readSubscriptionCoreWorkspaceConnections`, `.refreshExhaustedSubscriptionCoreQuota`, `deliverSubscriptionCoreProviderWake` |

- **Transcription and realtime** (EP-N03, EP-N05/N07/S17) use shared
  organization- or workspace-scoped connections only (decision 3): a
  sessionless `transcription` lease for the caller, a session-bound
  `realtime` lease for the session's recorded owner. Release note: after
  the cutover a personal SuperGrok account no longer serves transcription
  or realtime.
- **Video** (EP-T17/N11/N12/N13/N14). Funding availability (the policy
  route, the realtime catalog and transcription availability) is "a shared
  candidate exists for this workspace". In a turn, the video is funded by
  the first shared candidate for the session's owner whose stored quota is
  not exhausted now, also when the chat model is not SuperGrok; with every
  candidate exhausted there is no funding and no video tool, as legacy
  selection treated an exhausted account as unavailable. The operation stores an encrypted reference to
  that canonical connection (`kind: "subscription-connection"`, no token
  material; `connection_id` stays null, as the funding CHECK requires).
  Submission and polling run under a session-bound `video` operation lease
  on exactly that connection, read the bearer through the core seam and
  refresh only under the core lock. A personal connection never funds a
  video: the job outlives its turn and the lease guard refuses personal
  connections outside a turn. Without a usable connection (no session or
  owner context, refused lease, relogin) the run reschedules until the
  recovery deadline, then ends: `cancelled_before_submit` before
  submission, `outcome_unknown` after it, `retention_failed` while
  retaining (decision 6). A request counts as dispatched only when it
  reaches the transport after the core's custody reservation commits, and
  a 401 counts as none. A start stopped before any request was dispatched
  (the operation lease's fence failed, the reservation was refused, or a
  401 whose renewal needs a new sign-in) is verified
  (`SubscriptionCoreVideoDispatchRejected`) and ends `provider_failed`
  with no send time recorded, as the legacy path ends a relogin. It does
  not go back to `accepted`: the strictest outcome is a known, refunded
  failure, and the core path never replays a frozen start body. A start
  that may have reached xAI stays `submission_uncertain` and ends
  `outcome_unknown`. Funding skips exhausted candidates through a separate
  stored-quota read (`readSubscriptionCoreExhaustedConnectionIds`), so the
  candidate routine Codex shares is unchanged; an exhaustion that begins
  after funding still meets a 429, which, as on the legacy path, is not
  treated as proof that nothing started.
  Core video funding and core realtime also require the deployment's
  SuperGrok subscription switch. Migration 0727 admits a `video` lease in an
  ownerless session (shared connections only, no person), as 0698 did for
  ownerless turns; otherwise a scheduled task's video could never submit.
- **Status** (EP-N23) reads the workspace's shared pool and validates the
  effective primary with one `liveModels` read. Without a shared effective
  primary, only the owner-only Personal-workspace billing check below can
  establish validity; otherwise it reports `valid: false`. The payload shape
  is unchanged.
  The viewer's own personal connections, through the owner-only reader,
  count towards `connected` and `accountCount` wherever that reader shows
  them (another person's never). Only in the viewer's own Personal
  workspace, only when the shared pool has no effective primary, and only
  for a caller who passes the owner check of a private account
  (`requirePrivateSubscriptionHuman` with the Personal-workspace place, as
  the Claude core usage route gates a personal connection: the owning
  person with `connections:write`, by browser sign-in, a verified
  external-identity assertion linked to them, or an agent with their full
  access), is a personal connection the effective account (the first
  `active` one, scope `user` as on the legacy path), validated by one live
  billing read as its owner through the administered `personal_owner`
  probe, which also applies the organization's personal-connections rule
  (0735). Any other caller (a read-only agent, a plain bearer, the
  person's own API keys, read-only or full) gets the stored count with
  `valid: false`, and nothing is read live, recorded or woken. That reading is
  stored like any usage observation; when it ends an exhaustion the status
  wakes the organization's SuperGrok core waiters (`usage_recovered`, a
  failed wake never fails the status), as the Codex and Claude usage
  routes do. In a shared workspace a personal connection is never the
  workspace's effective account, so nothing is read live there.
- **Quota** (EP-N22). Core SuperGrok placement (`beforePlacement`) and the
  legacy callers on the core route (`refreshExhaustedXaiCoreQuota`) probe
  each shared connection whose stored quota is exhausted and was not read in
  the last 30 seconds, in the turn's explicit workspace context as the
  core's service subject (never a person, so never a personal connection),
  and wake the organization's SuperGrok core waiters on recovery (a shared
  connection serves every workspace it reaches). The core keeps a running
  exhaustion deadline against later readings (design 2.2); the adapter flag
  `usageReadEndsQuotaExhaustion` (SuperGrok only) makes a billing reading
  below the limit end a quota exhaustion, the legacy SuperGrok rule. Codex
  does not set it. An at-limit reading (no known reset) is not below the
  limit and leaves the exhaustion and its deadline in place.
  The exact accepted turn also re-reads the personal connections that
  placement's personal authorization admits for that turn, and no others,
  with the same 30-second interval
  (`refreshExhaustedSubscriptionCoreTurnPersonalQuota`). Placement's later
  choice can still pass over such an account (outside the Personal workspace
  it needs fallback consent or an explicit binding, and the provider switch
  applies in every workspace); the re-read is then the owner's own billing
  read under the 0735 owner checks, which widens nothing. Inside the
  accepted turn, placement's own `authorizeSubscriptionCoreFrozenPersonal`
  (`authorize_subscription_personal_placement_access`) requires the turn's
  initiating human to be the session owner, a private session or the
  owner's Personal workspace, the frozen v2 entry for exactly the owner's
  membership, and the organization's personal-connections rule, and mints
  per-connection access only at the connection's current authority
  generation; the personal rows that transaction can see are the allow-list.
  The stored rows of those connections come from the owner-only reader in
  the owner's Personal workspace, and each live read runs as the owner
  through the administered `personal_owner` probe there (whatever workspace
  the turn runs in), which rechecks the owner's membership, authority
  generation and the personal-connections rule. Another initiator, a shared
  session, background or shared-only work (no frozen entry), another
  provider's or membership's entry, a stale generation and personal
  connections turned off re-read no personal connection. A recovery wakes the
  organization's SuperGrok core waiters; any failure keeps the stored state
  and never blocks placement. The provider-neutral pieces live in
  `subscription-core/personal-connections.ts`
  (`subscriptionCorePersonalConnections`), keyed by provider only; the
  SuperGrok wiring lives in the worker's `subscription-core-xai-quota.ts`.
- **Personal connections (closed before X3).** X2a's core re-read only
  shared billing and its status listed only the shared pool, so a person
  whose only SuperGrok connection is personal saw `connected: false` and
  kept a stored exhaustion until its deadline. The status and quota rules
  above close that on the provider-neutral owner-only reads (#4159).
  The core waiter reconcile (X1b's `refreshBeforeReconcile` hook) calls
  `refreshExhaustedXaiCoreQuota` with the waiting turn's exact accepted
  identity (`personalTurn`) before it reconciles, so a personal connection
  is re-read only under placement's personal check for that turn, never as
  background work on its own. A parked personal turn can therefore resume
  before the stored deadline once billing recovers. SuperGrok
  has no organization-level status or usage route, so nothing else is
  affected.
- **Image** (EP-N09/N10). A core-placed SuperGrok turn generates images on
  its own placed connection (`executeCoreXaiImageGeneration`): an `image`
  operation lease keyed by the ledger operation id at the turn's execution
  generation, the chat lease checked (never taken) before the operation
  lease and before every request, the bearer from the core seam and every
  physical request in the core's custody. Anything that stops it before its
  first request reaches xAI returns the ledger row to `prepared`
  (`SubscriptionCoreImageDispatchRejected`): a request counts only when it
  reaches the transport after its custody reservation commits, a 401 counts
  as none, and any failure before that (lease acquisition, a refused
  reservation, a bearer that cannot be mapped to the xAI client's, a refused
  renewal after a 401) is a rejection. The session binding is never
  read or written; a legacy-placed turn keeps the legacy image path.

##### X2b: routes and writers

Dormant until the SuperGrok cutover receipt: each SuperGrok route, the
SuperGrok access policy and every acceptance path first ask whether the
`xai` receipt exists (one read); without it they run today's code
unchanged. With it, `readSubscriptionCoreProviderRoute` decides: `core`
serves the route from the shared core, `maintenance` (switch row missing or
disabled) answers the typed 503 `subscription_core_cutover_disabled`.

- **Routes (EP-S09, EP-S10, EP-S14, EP-S16).** The pool routes take an
  optional core hook (`apps/api/src/routes/subscription-pool-core.ts`,
  provider-neutral; Claude's hook is C2b's). Paths, verbs,
  bodies and response shapes stay; accounts are core connections projected
  into the legacy SuperGrok account shape (`subscription-core-xai-compat.ts`;
  the one quota window is the legacy percentage and reset), so the legacy
  `accountJson` renders both. Route ids resolve through the cutover aliases
  on both route families, as the caller (`resolveSubscriptionCoreRouteConnectionId`):
  an organization administrator sees every alias of the organization, any
  other workspace administrator the aliases of connections the workspace
  reaches, and a personal connection's alias resolves only for its owner in
  their own Personal workspace (inside the owner-only routine); the caller's
  projection or writer still decides whether the connection is theirs.
  Activate answers with the canonical id the listing shows.
  Activate sets the effective primary at the scope the caller administers;
  rotation maps to `spread` / `primary_first`; rename, allocator and
  disconnect use the neutral writers, behind the legacy browser and scope
  checks. Connect start fails closed in maintenance.
- **Workspace settings over an inherited pool.** As legacy, while an
  available organization pool serves the workspace, rotation and activate
  on a workspace route are refused (409, "manage this subscription in
  organization settings") before anything is written; the organization's
  settings change only on the organization routes. Otherwise they write
  that workspace's own setting, and whether a workspace may hold it is the
  organization's settings lock, enforced by the neutral settings writers.
  The one exception is the owner's own Personal workspace once they have a
  private account there (the listing's source is `user`): legacy changed
  their private pool's rotation, and on the core that pool is their
  Personal workspace's, which the organization pool may also serve. The
  owner's rotation, and activating their private account, write their
  Personal workspace's own override; the override takes the organization's
  current primary as its inherited primary, so the organization accounts
  serving that workspace follow the owner's order there and no longer
  follow later organization primary changes. Nobody else's work runs in that
  workspace, and the owner cannot make an organization account its
  primary. Without a private account the organization pool's 409 applies,
  as legacy; the 409 for activate applies to shared accounts.
- **Organization settings locks bind these writes.** The rotation and
  activate routes write through the neutral settings writers, so an
  organization lock on `rotation` (0724) refuses them with the 409
  `setting_locked` and writes nothing, as for Codex; this includes the owner's
  Personal workspace override above.
- **Private accounts live in the Personal workspace.** On the core, every
  route that manages a private (`user`) account (connect start and poll,
  listing personal rows, rename, allocator, activate, disconnect, rotation)
  requires the caller's own current Personal workspace with a live
  organization membership, where the core keeps personal connections; the
  legacy rule (an ordinary workspace membership) still applies before the
  receipt. `scope: "user"` outside the Personal workspace is refused at
  connect start, before the xAI sign-in. Rotation is authorized by the
  workspace (organization pool, own Personal workspace, else the workspace
  administrator), not by the listing's display `source`.
- **Organization activate** refuses, as legacy did (409), an account that
  is not active or that the allocator may not use; an unknown id is 404.
- **Connect admission.** Whether a workspace administrator may save the
  signed-in account (a reconnect of an account their workspace manages) is
  known only after the sign-in, so the neutral writer decides at poll time;
  connect start checks the scope and fails closed in maintenance.
- **Connect.** Organization and workspace connects create shared
  connections through the neutral writer with `credential_format =
  'xai_oauth_v1'`; the token identity subject is both the upstream account
  and the person. `scope: "user"` creates a personal connection only in the
  person's own Personal workspace and is refused elsewhere, never turned
  into a shared one (the strictest reading of "personal connections only in
  the owner's private session or Personal workspace"). Migration 0728 adds
  the personal writer overload that takes the format; Codex keeps the 0707
  writer and `v1`. The format is the adapter codec's
  (`credential.format`); a malformed one is a caller defect, thrown by the
  neutral writer before any write on every path (never a refusal or the
  maintenance 503). A test compares the two live overloads after 0728's
  four substitutions, so a later fix to one that misses the other fails.
  A shared workspace's connect is step W's shape
  ([§5.4](#54-workspace-managed-connections-as-organization-accounts)): an
  organization account that workspace manages, which the organization
  access editor shares. As for Codex on the core, a first connect leaves
  the primary unset (`isActive` false until an administrator activates
  one); with no primary the pool fails over across every eligible account
  (D-13).
- **Workspace listing.** `source` is `user` when the viewer's own personal
  connections are listed (their Personal workspace, owner-only), else the
  effective shared source. Listing personal rows requires the private
  browser human, as legacy.
- **Acceptance (EP-S18..S24).** The v2 writers merge every registered
  provider's entry (the `core*V2` writers); with only Codex registered the
  value is exactly Codex's. After each carrier insert on every path of
  "Accepted authority across the cutover",
  `copySubscriptionAuthorityCompatInTransaction` copies the record of each
  provider whose own cutover holds records: one read while none does. A
  carrier an upsert did not insert is skipped, and so is a task revision an
  earlier transaction inserted (a replayed or detached reusable-session
  materialization returns the existing head): the application role cannot
  read revisions, so 0728's owner-run
  `subscription_authority_carrier_inserted_now` answers for them.
- **v1 after the receipt.** The SuperGrok v1 resolvers return the column
  default once the `xai` receipt exists; derived rows already copy v1
  verbatim. The resolvers are provider-parameterized, so Claude's follow the
  same rule from Claude's own receipt (C3); before it they are unchanged.
- **Status (EP-S15) and media** stay with X2a; SDK, React and event names
  and shapes (EP-S26..S31) are unchanged.

Generalizations (old name, new name; the old names remain as aliases):
`receiverCodexSubscriptionAuthorityV2InTransaction` to
`receiverSubscriptionAuthorityV2InTransaction`; the
`codexSubscriptionAuthorityV2*` call sites to the merged
`coreSubscriptionAuthorityV2*` writers; the Codex workspace projection's
personal join to `readSubscriptionCoreWorkspaceView`;
`deliverSubscriptionCoreCodexWake` to `deliverSubscriptionCoreWake`;
`read/get/updateSubscriptionCoreCodexModelConnectionAccess` to
`read/get/updateSubscriptionCoreProviderModelConnectionAccess`; the neutral
connect writer gains `credentialFormat` and `personal`.

#### X3: the drained SuperGrok cutover

Migration 0740 (`-- deployment-mode: maintenance`) is the SuperGrok
counterpart of 0689 and follows "Data mapping", "Accepted authority across
the cutover", "Personal authority generations" and "Cutover protocol"
above. The runbook is `docs/deployment.md`, "SuperGrok on the shared
subscription core (0740)". Choices made where the plan left room, for
reviewers:

- **One writer for every provider's stage.** The credential stage is
  `packages/db/src/xai-subscription-core-cutover.ts`; it holds only the
  SuperGrok row shape, token identity, its four statuses and the quota
  mapping. Staging tables, personal generation minting and the connection,
  reach, alias, map and readability writes are the provider-neutral
  `packages/db/src/subscription-core/cutover-stage.ts`, which the Claude
  cutover calls with its own decoder and rules. 0689's Codex stage keeps its
  own writer unchanged: it belongs to a shipped migration whose SQL reads
  Codex-named staging tables and 0689-era relations, and a historical
  migration is not rewritten. The planner is 0c's
  `planSubscriptionCoreCutover` with SuperGrok's `SubscriptionCutoverRules`.
- **Video.** A non-terminal SuperGrok video operation's token envelope is
  replaced by the connection reference X2a's core video path reads
  (`{kind: "subscription-connection", provider: "xai", connectionId}`),
  read back before the replacement. An envelope whose credential cannot be
  resolved gets the nil connection id and a
  `disposition:video_operation_unmapped` row: the core path finds no
  connection and the operation ends at its recovery deadline (decision 6).
  An envelope funded by a `user` credential points at that owner's personal
  connection, which X2a's video lease refuses (video is never funded by a
  personal connection), so it ends the same way. Image operations keep
  their recorded identity and resolve it through aliases.
- **Organization locks.** A workspace override is never written for a key
  the organization row locks (`rotation`, which also governs the
  `*_primary_connection_id` columns, `providers` and
  `personalFallbackAllowed`). `subscription_effective_settings` already
  ignores a workspace override of a locked key, so the effective outcome is
  the one the lock gives, and M5's trigger, which refuses a workspace write
  of a locked key with `42501`, is never contradicted (0740 disables
  non-internal triggers on the relations it moves during the owner window,
  so the trigger would not fire there, but an unseen override would take
  effect if the organization later unlocked the key). The workspace follows
  the organization's locked value after the cutover. Each such workspace is
  listed in the report as `disposition:local_pool_freeze_locked:<workspace>`
  (its inference source was not frozen on `workspace`) or
  `disposition:local_rotation_locked:<workspace>` (its local rotation mode
  and primary were not applied), and the parity metric
  `locked_workspace_keys_untouched` proves every such key kept its value.
  An administrator who later unlocks the key re-applies the setting by hand.
  The settings trigger also admits a widening workspace write only at READ
  COMMITTED. The cutover's triggers are disabled during the owner window, so
  it is never reached, but the preflight still refuses any other isolation
  up front (`55000`), so a database or role default cannot change the
  outcome. The runbook says not to set one.
  Before any relation lock or settings read, the cutover takes each
  organization's shared settings lock
  (`pg_advisory_xact_lock_shared(hashtextextended('subscription-settings-locks:'
  || account_id, 0))`) in ascending order, as every workspace override
  writer must. The drained window means nothing contends. Every existing
  organization is locked because its cutover and settings rows are moved.
  Personal-workspace rotation and primary overrides move too: D-18 refuses
  them only through the administrator settings API, not the owner's routes
  or data migration. Organization locks still win and produce explicit
  non-parity dispositions.
- **Per-provider bindings.** Require the three-column binding key and the
  enabled provider-identity trigger. Keep that trigger enabled during the
  owner window; snapshot every non-xai binding and compare the whole row
  after migration. Automatic and explicit xai pins coexist with other
  providers' pins. The first drained provider cutover drops the rolling
  session-only index after preflight and before inserting bindings; later
  cutovers tolerate absence. Never restart an old image after that drop:
  old readers and Codex automatic UPDATE do not fail closed.
- **Steer and Cancel.** The legacy SuperGrok supersede in the Steer path is
  gone (no legacy waiter can be live after the receipt the binary
  requires). Steer and Cancel call
  `deleteSubscriptionCoreWaitersForTurns` with no provider filter, the same
  provider-neutral cleanup used by the core waiter runtime.
- **Read-only legacy.** `SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES` in
  `runtime-posture.ts` lists each provider's legacy tables (SuperGrok's five
  now, Claude's in C3). Role provisioning grants the runtime `SELECT` only
  on them once the provider's receipt exists. The posture evaluator
  tolerates full DML on a provider's legacy tables while its receipt is
  missing and then reports only the missing receipt, so a rolling binary
  before the window sees one violation, not five. Once the receipt exists,
  restrictive `<table>_closed_insert` and `<table>_closed_update` policies
  on each of the five tables refuse every insert and update (`WITH CHECK
  (NOT subscription_provider_cutover_committed('xai'))`). They are per
  command, never `FOR ALL`: a restrictive read policy without the
  `lifecycle_backfill_read_active` branch makes the product lifecycle
  backfill refuse the table as a source (found by its real-PostgreSQL
  suite), and reads need no change. New legacy
  `xai_subscription` authorities are refused by a restrictive `INSERT`
  policy on `organization_user_resource_authorities`. The legacy connect,
  rotation and pin routines run as the owner, which FORCE row security
  binds, so they cannot write either. The policies leave deletes open.
  Organization retention deletion removes an offboarded member's migrated
  connection with their Personal workspace; row security hides their legacy
  `user` rows from it, as before the cutover, and 0740 has blanked those rows'
  ciphertext. 0740 reduces the legacy disconnect routine to a refusal with
  `55000` (its old body could never run after the receipt), so it can never
  report a revocation while the moved connection keeps serving. Membership lifecycle still revokes, retains and restores the
  existing authorities. The migration asserts FORCE on the five tables.
- **Drain check.** Besides the listed runtime logins, the drain check
  refuses any other client session whose non-superuser role, other than the
  schema owner, can insert, update or delete any of the 37 relations the
  cutover locks, so a runtime login missing from the passed list cannot
  write during the window.
- **Personal fallback opt-in.** The opt-in follows the "Workspace-scoped
  credential in a Personal workspace" row only: owners of accounts connected
  in their Personal workspace are opted in, owners of only `user`-scoped
  accounts are not, because the preference is per person and would also
  cover their other providers' personal connections.
- **Quota window.** A SuperGrok connection's quota snapshot has one window,
  id `billing` (`SUBSCRIPTION_CORE_XAI_QUOTA_WINDOW_ID`), the id the core
  adapter writes for SuperGrok usage.
- **Readiness.** `SUBSCRIPTION_PROVIDER_CUTOVER_MIGRATIONS.xai` is 0740, so a
  binary with 0740 in its ledger refuses to start without the `xai` receipt
  (the provider-keyed readiness function
  `subscription_provider_cutover_committed('xai')`).
- **Tests of the legacy runtime.** Characterization tests of the legacy
  SuperGrok runtime run in a database that withholds 0740 (the shared test
  harness's `withheldMigrations` option builds a separate template with
  those ledger rows pre-recorded), the state a rolling deployment has
  before the window. X4 deletes them with the legacy runtime.
- **Temporal seam.** 0740 keeps every live waiter's id (as `waiter_id`),
  generation, wake revisions and blocked-turn generation and moves its
  pending wake to the wake outbox, so a workflow parked on a legacy
  SuperGrok wait reconciles the reference its history recorded (`provider:
  "xai"`, waiter id, generation) against the core waiter with the same id
  and fences. `test/integration/subscription-core-xai-cutover.integration.ts`
  parks a turn through the legacy arm path, records the peek result,
  migrates, asserts the moved waiter and outbox row, and replays the pinned
  capacity-wait history rewritten with SuperGrok references. Resuming
  through that reference needs X1b's core reconcile path for `xai`; X3
  merges after X1b. The integration suite covers the moved waiter,
  unchanged wake fences and reset timers, and workflow replay; activation
  also requires the parked Personal-turn quota-recovery path to pass.

#### X4: SuperGrok legacy deletion and the provider-neutral guard

- **Guard shape.** `check:no-legacy-subscription-runtime`
  (`scripts/check-no-legacy-subscription-runtime.ts`, run by
  `check:subscription-contract`; `check:no-legacy-codex-runtime` stays as an
  alias) is the M3 PR4 Codex check generalized. The engine names no
  provider. Each retired runtime is one entry in
  `scripts/legacy-subscription-runtime/` (`codex.ts`, `xai.ts`), registered
  in `index.ts`, with: `identifiers` (factory tables in both spellings and
  retired routine names), `patterns` (retired call or literal shapes whose
  identifiers stay shared, such as minting the synthetic
  `worker:xai-workspace` pool subject; recognizing it stays), optional
  `deletedModules` and `testFixtures`, and `exceptions` keyed by file with
  exact top-level declarations and exact string literals. One entry's
  exception never excuses another entry's identifiers. Claude C4 adds a
  `claude.ts` entry; the retirement step adds the routines it drops. Neither
  changes the engine.
- **SuperGrok entry.** The five factory tables, the six legacy routines
  (`create_`, `disconnect_`, `resolve_*_authority_pool`, `revalidate_*`,
  `*_authority_live`, `*_pool_visible`) and the synthetic subject.
  Exceptions: the schema declarations, the posture inventories
  (`FORCE_RLS_TABLES`, `SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES` and the
  routine-signature constants of the posture contract) and the SuperGrok
  cutover migration's codec stage, which reads the legacy rows before its
  scrub; the legacy secret decoder it calls stays for as long as that
  migration ships.
- **What X4 deletes.** The xAI selector arm (the legacy branch after the
  provider's receipt check), the factory repository instance for `xai` and
  every v1 SuperGrok reader and writer that used it (connect, disconnect,
  rotation, pins, leases, waiters, quota), xAI use of
  `ScopedSubscriptionTurnLease`, the legacy video token envelope code and
  the M1 shadow for `xai`. Shared factory code stays for Claude until C4.
  The v1 carrier columns are still written with their default and copied
  verbatim on derived rows (the 0608 and scheduled fences compare them);
  no reader derives them from live state (the stored values that still
  decide are listed under "X4 as delivered"). X4 merges only with
  `packages/db/test/subscription-core-xai-copy-paths-postgres.test.ts` (the
  `compat:dependent_sources_without_record` copy-path test) green at its
  head.
- **X4 as delivered.** Rolling; no migration.
  - Deleted modules: `packages/db/src/xai-subscription.ts` (the
    `xaiSubscriptionRepository` factory instance),
    `packages/db/src/organization-xai-subscriptions.ts`,
    `apps/worker/src/activities/xai-quota.ts` and
    `apps/api/src/xai-subscription-auth.ts`. In `packages/db/src/index.ts`
    the `xaiCapacityRepository` waiters and every `xai` waiter arm (arm,
    reconcile, supersede in `updateSessionVariableSets` and
    `createScopedSubscriptionCapacityWaiters`) are gone, as are the `xai`
    branches of the legacy credential lease heartbeat, failure settlement,
    finalization, worker capacity peek and reconcile, the legacy video token
    envelope (`xai-subscription` kind, `encryptVideoGenerationXaiCredential`,
    its reconciliation and submission paths) and the M1 shadow's `xai`
    world. `apps/worker/src/activities/agent-turn/xai-capacity.ts` is now
    `scoped-subscription-capacity.ts` and serves Claude only.
  - Selector arm: every SuperGrok entry point (worker turn build and video,
    API status, connect and pool routes, transcription, realtime, model
    connection access, catalog readiness and default session model) treats
    any route other than `core` as it treats `maintenance`: it fails
    closed. The provider-neutral route readers are unchanged; the API routes
    share `requireSubscriptionCoreRoute`, which resolves the organization
    (so authorization runs) before its typed maintenance refusal, also
    without a receipt. Billing funding fails closed as unfunded rather than
    as maintenance: off `core` a SuperGrok model is never funded without
    credits, so admission may refuse it for credits or admit it and leave
    the worker to refuse it with the maintenance error; no SuperGrok work is
    funded off `core` either way. A typed "provider paused" admission
    refusal would add a denial code to every admission consumer (goal
    pause reasons, scheduled refusals, automations) for a per-organization
    maintenance state; it is left to a later change.
  - Chat Completions: the stateless single-call API neither lists nor
    serves SuperGrok subscription models (`model_not_found`), because the
    core's single-call `completion` kind stays Codex-only (PR 0b's kinds).
    Before X4 the same call already answered 503 after the cutover, since
    the deleted legacy path read only scrubbed rows.
  - Video: a non-terminal SuperGrok video operation whose envelope is not a
    shared-core connection reference (one the cutover did not convert, or a
    restored row) is never decoded; like an unavailable connection it waits
    until its recovery deadline and then ends.
  - Shared factory: `subscription-account-repository.ts` is parameterized by
    its provider options and names no `xai` routine; Claude's instance and
    `ScopedSubscriptionTurnLease` are unchanged.
  - v1 carriers: SuperGrok's v1 value is written as the column default
    (`{ version: 1, scope: "workspace" }`) and copied verbatim on derived
    rows; no reader derives it from live state. Stored v1 values still
    decide in these places, which retire only with a fence migration that
    takes SuperGrok's causal subject from the owner and the v2 value: the
    scheduled dispatch (`scheduled-tasks.ts` reads the task's snapshot,
    refuses on it and takes the run's causal human from it) and the
    deployed `admit_scheduled_agent_run_execution` and
    `record_scheduled_task_revision_authority` routines; the API's 409 on
    a material edit of a user-scoped SuperGrok task by anyone but its
    creator (kept, so such an edit cannot leave every later occurrence
    refused); the goal-continuation check, `subscriptionExecutionAuthorityFromTurn`
    and the user-to-shared narrowing in `receiverSubscriptionAuthorityInTransaction`;
    and `createSessionInTransaction`, which sets the creator's subject RLS
    context when no snapshot is supplied. A cutover database holds only
    workspace-scoped values for new work, so for it these reduce to the
    shared case; tasks and turns accepted before the cutover keep theirs.
  - Kept, with reasons: the legacy secret decoder and the codec stage in
    `xai-subscription-core-cutover.ts` (the SuperGrok cutover migration
    still ships); the schema, posture inventory and routine signatures (forensic tables and their
    grants until the retirement step); `@opengeni/xai-subscription` (the
    protocol package the core adapter uses); the worker `xai-auth.ts`
    helper, now core-only; `XaiSubscriptionAccountMetadata` (the public
    account shape the core routes return). Tests that need pre-cutover rows
    build them through the test-only `packages/db/test/fixtures/legacy-xai.ts`.
  - Guard: the SuperGrok entry additionally lists the deleted repository,
    waiter, quota, authorization and video-envelope names, the deleted
    module files (`deletedPaths`: relative specifiers are resolved from the
    importing file, and templates without substitutions count as literals,
    so `@opengeni/xai-subscription`, the transcription provider and the
    `*-core*` modules stay importable while any `./` or `../` form of a
    deleted file is refused) and `legacy-xai` as a test-only fixture. Its
    exceptions are unchanged: schema declarations, posture inventories and
    the SuperGrok cutover migration's codec stage.

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
| §3.7 says the 0608 inbox fence compares Codex against v2, but no later migration redefines `fence_inbox_execution_context`, so receiver-context turns are not fenced on `subscription_authority` in SQL. Scheduled admission and occurrence functions do not compare v2 either; the 0688 revision trigger only fills a NULL revision value. Both need a v2 comparison. | 0608, 0275, 0478, 0688 | PR 0b part 2 (0717): the inbox fence and the scheduled occurrence compare v2; scheduled admission adds no v2 comparison of its own, by choice (the revision it pins already carries the task's v2 value; see the Admission bullet in part 2's choices) |
| §3.7 says Claude stays compared against its v1 columns, but scheduled admission (`admit_scheduled_agent_run_execution`, restated by 0478 with the 0416 and 0447 changes and patched in place by 0501; `validate_scheduled_occurrence_accepted_execution`; `validate_scheduled_agent_run_live_authority`; the occurrence and turn-execution fences) never compares Claude: not the run's accepted Claude snapshot, the occurrence update, nor the generated session's `initial_claude`, and there is no Claude equivalent of `scheduled_xai_authority_changed`. Claude scheduled pools are fenced only in TypeScript. | 0275, 0416, 0447, 0478, 0501 | PR 0b part 2 (0717) |
| The three 0608 `SECURITY DEFINER` routines kept the migration's search path (`"$user", public`), which searches `pg_temp` first for relations. | 0608 | PR 0b part 2 (0717) |
| The `scheduled_turn_execution_immutable` trigger fires `BEFORE UPDATE OF` a column list with only the xAI snapshot, so a Claude snapshot or v2 update of a scheduled turn never reaches its fence. | 0275 and its xAI successor | PR 0b part 2 (0717) |
| 0598 copied the xAI policies of `organization_memberships` by the pattern `xai_subscription_capability_%` and missed `xai_subscription_membership_lock`: under a migration owner without `BYPASSRLS` (the documented posture) connecting a personal Claude account fails with `42501`. | 0598 (0442's xAI policy) | PR 0b part 2 (0717) |
| No policy lets the SuperGrok or Claude lifecycle capability update `organization_user_resource_authorities`, so under such an owner a personal disconnect deletes the credential and leaves its authority active, and runs accepted for the disconnected account keep passing the `user` generation check. Existing tests ran as a superuser. | 0234, 0442, 0598 | PR 0b part 2 (0717): revoke policies, and a repair of the authorities left active |
| Under such an owner the v2 writers see no personal connection: they count the owner's personal generations holding only an account `lifecycle` capability, which no `subscription_connections` policy honours for personal rows, so every acceptance freezes the empty value and a personal Codex account is never used after the cutover, even in the owner's private session. Existing tests ran the writers on superuser-owned databases. | 0669, 0688, 0707 | PR 0b part 3 (0726): the writers count through the owner-only membership-lifecycle read |
| Under such an owner the health-recovery routines see no personal connection either, so a due 403 quarantine of a personal account is never lifted, even for the owner's own turn whose frozen entry names it. | 0669, 0707, 0715 | PR 0b part 3 (0726): both collect their candidates under the same marker, restored before they write |
| The `{codex,claude,xai}_primary_connection_id` foreign keys omit `provider`, so a primary can reference another provider's connection. | 0642 `subscription_settings` | PR 0, or M4-A's settings shape |
| The non-Codex branch of `authorize_subscription_personal_access` compares the owner subject but neither requires the connection's owner membership id to equal the session owner's membership nor checks `personalConnectionsAllowed`. | 0668 | PR 0 |
| `autoRenews` is a static adapter flag but is documented as false for setup tokens. | `packages/subscriptions/src/adapter.ts` | PR 0 |
| EP-N13 (organization-scope video envelope rejected) and EP-N14 (direct refresh outside the lock) are still present. | `video-generation-credential.ts`, `video-generation-reconciliation.ts` | X2a |
| The M3 Codex cutover kept each verified `user` row's legacy generation and gave Personal-workspace rows generation 1 (`codex-subscription-core-cutover.ts`, 0689), the ambiguity "Personal authority generations" avoids. An owner left with more than one current Codex generation gets an empty personal v2 entry on every new acceptance (0669, 0688), silently losing personal Codex access; the 0688 connect writer assumes one generation. | `codex-subscription-core-cutover.ts`, 0669, 0688, 0689 | PR 0 adds the count (owners whose active, serviceable personal Codex connections carry more than one current generation) to the readiness report and runbook. The repair, one fresh generation per affected owner as in M4, is an owner decision (open question), because older frozen v2 entries then lose personal reach. |
| The `model.connected` lifecycle fact is emitted only by triggers on the legacy credential tables, so Codex connects stopped producing it after the 0689 cutover. | 0565, 0598, 0602 triggers | PR 0 (provider-keyed fact on core connection insert) |
| A deleted explicit target was silently re-chosen: the placement world maps a binding whose connection reference is cleared to no binding (`subscription-core-placement-world.ts`), so an explicit pin whose account was deleted (`ON DELETE SET NULL`) looked like no binding, placement picked an account automatically and its commit wrote that account as the session's explicit choice, against D-24 and the 0642 comment that such a pin must stay an explicit, unavailable pin. | `subscription-core/turns.ts` (M3 placement) | Per-provider bindings PR (0733): it waits as `pinned_account_ineligible`, and the commit refuses to write over it. Follow-up needing an owner preview: the Codex account picker shows such a pin as "Auto" (checked) until a turn waits on it; choosing "Auto" or an account during the wait clears it. |
| One binding row per session: after a second provider joins the core, a session pinned to one provider's account fails work on another provider's model (`pinned_account_ineligible`), and a placement of the other provider replaces the pin. Before the shared core each provider kept its own pin. | 0642 `subscription_session_bindings` key | Per-provider bindings PR (0733, D-32). |
| Resolved since the inventory baseline: its open question on 0263 lacking `claude_subscription` (correct at `0d7075e`) no longer applies, because 0642 added `claude_subscription` and `subscription_connection` to the retention function. The inventory is a baseline record and is not edited. | inventory §4.2.4 | nothing to fix |

Open questions for the product owner: whether owners may later choose their
personal account in a shared session (an M5 widening this plan does not
make); whether anyone depends on personal-only SuperGrok transcription or
realtime, which decision 3 removes; and whether to repair Codex owners with
several current generations (finding above) if the count is not zero.

#### Claude track

Claude (`claude`) joins the core as an adapter and binding
(`packages/db/src/subscription-core-claude-adapter.ts`), unregistered until
C3 adds its SQL registry row (until then a test asserted production registered
nothing; since C3 the binding is registered and the conformance suites run it
as production does).
Facts the adapter declares, each read from today's Claude path:

- Credential. The stored plaintext is the legacy secret object unchanged
  (`ClaudeSubscriptionCredential`: `version`, `token`, `identity
  {accountUuid, deviceId}`, optional `oauth {refreshToken, expiresAt,
  scopes}`), so C3 copies it without rewriting. The credential format is
  `claude_oauth_v1` with `oauth`, else `claude_setup_token_v1`, always
  derived from the decoded secret (`credential.format`) when the core
  decides renewal. `capabilitiesFor` renews only `claude_oauth_v1`; any
  other format, including one a newer binary might write, never refreshes
  (fail closed). The stored `credential_format` column is not read for that
  decision: the shared connect and reconnect writers record the encryption
  envelope version there (`v1`, as for Codex), so nothing may treat the
  column as the Claude format; the `capabilitiesFor` contract text in the
  shared adapter interface is corrected with the C1a call sites. The
  embedded expiry is `oauth.expiresAt`; a setup token has none.
- Refresh. The legacy OAuth call (`requestClaudeTokenRefresh`, ten-second
  deadline), 60 seconds before expiry as the legacy resolver does. A 401 or
  `invalid_grant`, or a response missing a required scope, is a relogin;
  anything else is a retryable failure. A setup token is never refreshed: a
  refusal marks it needs-relogin through the shared refresh (as today, where
  only a new token recovers it). The identity, including the
  scope-derived `deviceId`, is kept across refreshes.
- Capabilities. No Opengeni-managed extra credits (Claude's paid overage is
  the provider's own setting, read from its usage reports), no plan
  entitlements, no media, realtime, Apps or remote compaction; usage
  windows. Cache facts: the exact 5-minute TTL Opengeni sends.
- Health. A 429 without a retry time rests 60 seconds, a limit without a
  known reset is rechecked after 60 seconds (the legacy
  `UNKNOWN_RESET_RECHECK_MS`). The forbidden quarantine is declared but
  unused: Claude's 403 classifies as `fatal` (decision 7).
- Usage in the shared quota model (`decodeSubscriptionCoreClaudeQuota`, for
  response headers and the usage endpoint alike), preserving
  `claudeSubscriptionCapacity` for the one response observed (a unit test
  compares both on realistic headers, per model, across the resets):
  - Paid overage the response allowed covers every plan limit it reports: a
    full account window becomes a `warning` and no family or request limit
    blocks. Today's rule grants this only to the model the response was
    for; overage is the Claude account's own setting, so the core grants it
    to every model of the account (deliberate, recorded difference toward
    dispatch). It is bounded like the others: a model whose own limit the
    overage does not cover is refused once, and that response's headers
    record its limit again. A rejected request whose overage was refused
    with a known reset before the request's own plan reset ends the blocks
    that response reports for the models it concerns (its own model;
    without one, the family its limit names, else every model) no later
    than the overage reset, as today's `nextCheckAt` does for the models
    whose capacity that request decides, and only while the request's own
    plan limit still runs; the other models keep waiting for their own
    limits. An overage reset at or after the plan reset ends nothing, as
    today's rule never rechecks then. After such a recheck, today's rule
    blocks the model again once the plan reset passes if a longer limit
    (a family window) still runs; one cooldown cannot express "free, then
    blocked again", so the core keeps the model free: a recorded difference
    toward dispatch, bounded by one refused request, whose headers record
    the limit again. An overage allowance whose reset has already passed
    covers nothing. One whose reset falls before the plan limit's covers
    the limit until a newer response arrives, where today's rule blocks
    again after the overage reset: a recorded difference toward dispatch,
    bounded the same way.
  - The five-hour and seven-day windows decide the connection's capacity
    (`rejected`, or full without a status, is `exhausted` until the reset, a
    minute when unknown). A model-family window (Opus, Sonnet) never decides
    the account: when full or rejected it becomes a cooldown of each of the
    organization's models of that family, and is reported with `unknown`
    status. The paid overage windows (`overage`,
    `seven_day_overage_included`) never block, refused or full, as today's
    rule never consults them.
  - A rejected request, and each rejected request restriction the
    observation carries (unless a later allowance of the same model lifts
    it), cools the model it was made for; without a model, the family its
    limit names, else it exhausts the connection (kind `quota`).
  - The model a response was allowed for dispatches whatever else that
    response reports, until the allowance's own reset (a minute when
    unknown). A limit that outlasts the allowance limits that model too,
    from the observation on, where today's rule still dispatches it until
    the allowance's reset (a difference toward waiting). When some models
    are judged apart (an allowed model, or a recheck concerning only some
    models), an account limit cools the listed models one by one instead of
    exhausting the connection, and the window is reported as a `warning`.
  - Cooldowns are keyed by product model id under both Claude prefixes
    (`organization-claude-subscription/…`, `workspace-claude-subscription/…`).
    A family limit, and an account limit judged per model, reaches the
    models listed when the response is decoded, and always the response's
    own model: C1b and C2a pass every Claude model the connection can serve
    (the deployment's Claude catalog at that moment, a superset of any
    organization's), and C1b tests that the
    worker does. A model missing from the list (for example one added later)
    is dispatched until its first refused response records its limit.
  - Differences from today's merged reading. A later allowed response does
    not end a running cooldown or connection exhaustion early (the shared
    model never shortens either; the reset or an explicit store operation
    ends it), which only waits longer. Before C1a the shared store replaced
    the stored windows with the newest observation's, so a reading that
    omitted a window dropped that window's running exhaustion, where today's
    merged reading keeps it. Recording the window in `exhaustedUntil` instead
    would let no later usage reading show an early reset, which today's
    reading does. So C1a, before any Claude call site exists, makes the
    shared `applyQuotaObservation` keep a stored exhausted window with a
    known future reset that a newer response-header reading or refusal
    omits, until that window's reset (provider-neutral, toward waiting, with
    the Codex and SuperGrok suites run against it). Whether a usage-endpoint
    reading is complete is the adapter's declaration
    (`usageReadingsComplete`, C2a): only a usage reading of an adapter that
    declares it replaces the stored windows outright, so it can show an
    early reset, including of a refusal's `exhausted_without_reset` fallback
    window; any other usage reading keeps an omitted exhausted window like a
    header reading (absent means partial: fail closed). Codex, SuperGrok
    and the conformance API-key connector declare complete readings, which
    keeps their behaviour. Claude declares partial readings: `/api/oauth/usage`
    can omit an account window that is still exhausted, and #4120's rule
    treated every
    usage reading as complete, which would end such a block early where
    today's merged reading keeps it (a defect in merged work, fixed in C2a).
    A Claude refusal's fallback window therefore rests its full minute even
    when a usage reading shows capacity (toward waiting); the shared
    conformance case asserts the declared behaviour for each subject. A
    two-observation shared test covers all three sources and both
    declarations, and the adapter's tests cover a header and a usage
    reading that omit an exhausted window; C3 (which registers Claude)
    requires both. C3's combined cutover ledger test covers the case on real
    data.
  - C3 re-keys the legacy cooldowns and restrictions: the legacy reading is
    keyed by Anthropic's upstream model id, the core by product model id, so
    the cutover maps each through `subscriptionCoreClaudeProductModelIds`
    (both prefixes) rather than copying keys.
- Classification (C1b, worker): a reconnect-required refresh or HTTP 401 is
  `unauthorized`; 429 is `rate_limited` with the request's model and the
  retry time; 529 or `overloaded_error` is `overloaded`; 403 is `fatal`; a
  safety refusal is not a provider outcome.

Recorded for the C1a call sites: Claude's workspace model policy names
models by their scope-specific provider id
(`organization-claude-subscription` or `workspace-claude-subscription`),
while `modelPolicyProviderId` is one value per adapter (§5.1.3 lists this as
still missing). The adapter declares the organization id; C1a makes the
policy provider id a function of the model in the shared placement world,
in a provider-neutral change after the SuperGrok track's X1a and X1b. Until
C2 adds workspace-scoped connections, a workspace-scoped Claude model runs
on organization connections on the core, so it must be allowed under both
its own identity and the organization identity: the per-model identities
only ever narrow access (review finding on #4132).

##### C1a: Claude chat call sites (implemented)

Built on the X1a/X1b generalizations (core turn lease, placement, request
lanes, placed-core helpers); dormant until Claude's receipt (C3), because
every Claude entry point reads the provider route first and the binding is
unregistered until then.

- Policy identity. The shared adapter interface gains an optional
  `modelPolicyProviderIdsFor(modelId)`, read through
  `subscriptionCoreModelPolicyProviderIds(adapter, modelId)` by the
  placement world, which admits a model only when the workspace policy
  allows every identity it carries (an empty or absent list means the
  declared `modelPolicyProviderId`). The Claude adapter returns
  `[organization]` for an organization model and `[workspace,
  organization]` for a workspace-scoped model, because on the core it runs
  on organization connections; providers with one identity declare nothing.
  The shared conformance suite asserts, for every provider, that a policy
  naming only a model's first identity never admits a model that carries
  another, and that allowing all of them places it.
- Placement. `selectClaudeTurnCapacityByRoute`: `legacy` runs the legacy
  Claude selection unchanged after one route read; `maintenance` fails
  closed; `core` places the accepted turn (holder
  `claude-turn:<workflow>:<turn>:<attempt>`, the legacy Claude lease TTL)
  and adopts the core lease. `ClaudeTurnLease` becomes a core subscription
  turn lease, keeping the legacy heartbeat while a legacy subject holds it
  and the `claude_credential_lease_lost` code. A core turn never enables the
  legacy rotation, and carries no legacy authority snapshot or credential
  version. No park until C1b: a core wait is a terminal capacity failure,
  and compaction defers with its request preserved.
  Until C1b, a core 429, 529 or unrenewed 401 settles through the generic
  provider recovery (no account refusal is recorded and the overload lane
  is not yet distinguished), so C3 must not register Claude before C1b has
  merged. Unreachable while dormant.
- Materialization and refresh. The bearer comes from the shared turn token
  resolver under the exact accepted turn and the attempt's live core lease;
  the capability settings carry only the account identity, the connection
  id and refresh generation with a placeholder token, and each request's
  custody sets the live bearer (OAuth `authorization`, tested with the
  production provider shape); the token scope follows the
  accepted product model's prefix. A 401 renews through one forced refresh
  per attempt (memoized, under the connection's refresh lock in the shared
  resolver) and retries the same request on the same connection, as a new
  reservation, only when the generation advanced past the refused bearer's;
  otherwise, and for a second 401, the refusal surfaces (classified in C1b).
- Request custody. The Anthropic transport's per-request preparation
  (`withClaudeUsageObserver`) gains an optional custody: the dispatch fence
  and reservation are the last awaited step before each physical fetch; an
  error status settles refused (408, 409 and 504 unknown); a successful body
  settles when it ends or stops, read by a Claude response inspector
  (`message_delta` or `message_stop` is a response, an `overloaded_error` or
  `rate_limit_error` event before any content block a refusal, any other
  stream error such as a timeout or conflict and anything else unknown); a
  failed fetch is unknown, and a response the custody cannot settle is
  cancelled. An unknown outcome is never replayed: later requests of the
  attempt are refused locally. A paused web search (`pause_turn`) continues
  the same model call with a new physical request before the history
  checkpoint: Claude's main lane declares `continuesAfterResponse` (the
  title lane does not; a title call never continues), so a further
  reservation is admitted while every pending request of the lane has
  received its response (each still reserved before its I/O and settled
  once at the checkpoint); any request without a response still refuses
  the next one, and lanes that do not declare it keep refusing any pending
  request (review finding on #4132). The 401 renewal resends the same body
  only when it can be sent again; a forced refresh that fails stays failed
  for the attempt. A 529 settles refused on its connection and is never
  refreshed or retried in place; that it never rotates accounts is C1b's
  settlement. The capability settings carry the account identity with a
  placeholder bearer, so a request outside custody fails closed upstream.
  The placeholder is unique per connection and credential version: for an
  account without a UUID (a setup token) the settings' key also scopes
  stored hosted web searches (#4143), and one shared placeholder would
  replay one account's encrypted results to another, which Anthropic
  rejects (review finding on #4132).
  Session titles use their own lane under
  the same fence; only an admitted main-lane request moves the generation
  the refusal settlement fences on (`core.credentialVersion`), so a title
  request renewed after a 401 never does. As with the title-independent
  recovery in #4179, tool-less title requests never enter history and do not
  block main-request recovery or failover; unknown or unresolved main requests
  still fail closed. The legacy usage observer, its receipts and its usage
  rows are not used on a core turn; header usage becomes quota
  observations in C1b.
- Readiness and `list_models` use the merged C2a implementation below, not a
  second C1a reader. `readSubscriptionCoreClaudeCatalogReadiness` projects
  workspace and organization readiness and allowlists separately, and one
  projection is shared with the restriction loader. A frozen legacy authority
  snapshot no longer selects the core pool. Legacy Claude pools are never read
  on the core route; maintenance closes both prefixes. Workspace and eligible
  Personal-workspace pools retain their workspace-prefixed catalog models.
- Funding and attribution: admission funding on the core is opt-in per
  provider (`CORE_ROUTED_FUNDING`, from X1b); C1a adds the `claude` entry, so
  a Claude admission reads its provider route only while Claude
  subscriptions are enabled on the deployment (credential source `claude`).
  Usage facts attribute the core connection through the placed core turn,
  and the legacy model-connection check is skipped for a core turn.

Conformance. The shared suite runs against the production binding twice,
with OAuth credentials and with setup tokens; the suite decides whether a
subject's credentials renew from their format
(`subscriptionCoreCredentialRefresher`), so a setup token takes the
"refused static credential becomes needs-relogin" case while OAuth takes the
"refreshed once and retried" case, and any token call fails the setup-token
run. Claude's own refusal classification is the worker's (C1b); until then
the suite's scripted classification is used.

##### C2a: usage, readiness and admission

C2a moves the Claude usage routes (EP-N24, EP-S13), catalog readiness
(EP-T18, EP-S25, EP-N26) and organization custom-model admission onto the
core. Every path first reads the organization's Claude provider route:
`legacy` (no receipt, every organization until C3) runs today's code
unchanged after that one read; `maintenance` fails closed (the usage routes
answer the typed 503 with `subscription_core_cutover_disabled`, readiness is
not ready for both prefixes, admission admits nothing); `core` uses the
`SUBSCRIPTION_CORE_CLAUDE` binding, which stays unregistered until C3, so a
core read before C3 fails closed in the registry.

- Usage members. The adapter's `fetchUsage` is the legacy
  `/api/oauth/usage` read (ten-second deadline, 64 KiB bounded body,
  `redirect: "error"`): a credential without the `user:profile` OAuth scope
  answers `scope_required` without any request (setup tokens never have
  it); a 401 is `reconnect`, the 403 `user:profile` scope message is
  `scope_required`, anything else is `unavailable`. `decodeQuota` decodes
  only an `available` reading, through `decodeSubscriptionCoreClaudeQuota`,
  with the caller's `modelIds`. Both members live in
  `subscription-core-claude-usage.ts`; the adapter file only wires them.
- `provider_state.oauthScopes`. The connection's adapter-owned
  `provider_state` records the credential's OAuth scopes as a string array:
  the granted scopes for an OAuth credential, `[]` for a setup token;
  absent means unknown. C2b's connect and reconnect writers and C3's data
  move (from the legacy credential's `oauth.scopes`) must set it. GET reads
  it (no credential is decrypted to answer a read); refresh decides from the
  decoded credential. `scope_required` and `reconnect` are response values,
  never stored: `reconnect` when the connection is `needs_relogin` or the
  probe reports a relogin, `scope_required` when the scopes are known and
  lack `user:profile`.
- Projection. `projectSubscriptionCoreClaudeUsage(row, refresh?)` maps the
  core quota row to `ClaudeSubscriptionUsage`. `credentialVersion` is the
  connection's row `version`, the same value as the account listing's
  `version` (C2b): it moves on reconnect and rename, never on a token
  refresh, and is a positive integer for every visible connection,
  including one with no reading. A row without one throws (fail closed: a
  connected account never reports 0 or null); every shared row read carries
  it, and a personal row takes it from the owner-only
  `readSubscriptionCorePersonalConnectionVersionsInTransaction` (0730,
  derived from the 0707 owner reader, returning only id and version) or is
  not visible. `connected` is always true: the readers return no
  disconnected connection. Stored windows stay visible across credential
  generations, as legacy kept them across token refreshes. Windows keep the
  legacy ids only (an unknown id is dropped, duplicates keep the first),
  `usedPercent` and ISO resets. Status: `exhausted` is `rejected`; after a
  usage-endpoint reading every other window is null (legacy usage windows
  carried no status); after a header reading `ok` is `allowed` and
  `warning` is `allowed_warning`; an Opus or Sonnet family window is
  `rejected` while a model of that family has a running cooldown, and the
  overage window while it runs and the quota's capacity is exhausted (so
  the UI keeps "limit reached" and the overage "Unavailable" label);
  otherwise null. The source is `provider` for a usage-endpoint reading,
  else `response_headers`. Refresh status, in order: `reconnect` for a
  connection that needs a new sign-in; the given refresh result;
  `scope_required` from `oauthScopes`; `available` for a stored
  usage-endpoint reading (checked at its observation); else `not_checked`.
  C2b's pool account listing uses the one-argument form; its row must carry
  `version`.
- Accepted differences from legacy (the core quota row stores one
  observation time and source, not one per window): every window carries
  the newest observation's time and source, including an exhausted window
  the partial merge kept from an older reading; and a GET after a header
  observation answers `not_checked` with no check time even shortly after a
  successful refresh (legacy kept the last refresh outcome). A window the
  usage endpoint reports at 100% is projected `rejected` (the core decoder
  marks it exhausted), where legacy showed null for every usage-endpoint
  window. A reconnect keeps the stored windows, now under the new
  `credentialVersion` (the row version moves on reconnect), until the next
  reading. For a verified identity (an account uuid) a reconnect cannot
  change the connection's provider identity, so those windows still
  describe the same account. For an unverified identity (`setup:` or
  `oauth:` without an account uuid, which C2b's reconnect identity keeps
  unchanged) a setup-token reconnect may bring another account's token, so
  the stored windows may describe the previous token's account until the
  next reading, which then comes from response headers (setup tokens never
  read the usage endpoint). Keeping them is still accepted: it is
  display-only and the stricter choice. All four are display-only and fail
  toward showing a newer check or a stricter state.
- Visibility. Account ids resolve through the cutover aliases: shared ids
  through the generic resolver, personal ids only through the owner
  routine's `resolve` action (`manage_subscription_core_personal`, called
  directly in a provider-neutral way; X2b's
  `resolveSubscriptionCoreRouteConnectionId` wraps the same action and
  replaces the direct call when the stack merges). A workspace route sees a
  shared connection of the workspace's effective pool (its legacy scope is
  the pool source, so today's private-human and scope-mutation checks apply
  unchanged, including the 409 for an organization-pool connection on the
  workspace path), or the caller's own personal connection only in the
  caller's own Personal workspace through the owner-only reader; its
  verified owner is checked there (X2b's `personal_workspace` place of the
  private-subscription check, D-03), not by the legacy ordinary-workspace
  membership rule, which no Personal workspace passes. The
  organization route reads the organization pool for an organization
  administrator only. Anything else is the legacy 404; a malformed id never
  reaches SQL.
- Refresh. POST refresh reads live usage through one of three seams, each
  under its own authority: a shared connection of the workspace pool
  through the core connection seam in workspace scope; the caller's own
  personal connection in their own Personal workspace through the
  owner-only seam; and an organization-pool connection on the organization
  route through the administrator seam (both C2c, below). The decoder gets
  every Claude model the caller's catalog lists (`modelIds`): the
  workspace's catalog on a workspace route (both prefixes), the
  organization's Claude models on the organization route (read as the
  administrator; when they cannot be read, nothing is read live). The
  organization route has no workspace catalog, so a workspace's own model
  gets its family cooldown from that workspace's reads; a later reading
  never shortens a stored cooldown. The probe reports whether its reading
  was applied (`applied`;
  the generation fence or a failed write leaves it unapplied): an unapplied
  reading, or one whose read-back fails, answers `unavailable`, never
  `available`. A recovery wakes the Claude core waiters
  (`usage_recovered`); a failed wake is dropped and never fails the
  committed read, on every path. Any seam that refuses (not visible,
  maintenance, a revoked authority, personal connections switched off for
  the organization) or cannot read (no usage read) reads nothing and answers the stored
  projection with `unavailable` and no check time (`reconnect` and
  `scope_required` kept), the Codex rule that a connection the caller's
  context cannot read reports no data (5.1.1, PR 2c). A refusal sent
  nothing, so the throttle does not remember it and it never outlives its
  cause; a credential or transport failure is a remembered failed attempt
  (`unavailable` with its check time).
- Administered refresh (C2c; D-01 parity: legacy read organization and
  user-scope accounts live). This closes the live refresh gap C2a recorded
  (the C3 precondition in the Claude track's C3 row). The organization
  route refreshes an organization-pool connection for an organization
  administrator through the `organization_administrator` scope, and the
  owner's personal connection refreshes in their own Personal workspace
  through the `personal_owner` scope, both of the shared administered usage
  reads (5.3, "Administered usage reads"). A workspace-managed connection
  stays with its workspace (the workspace path's 409 rule).
- Known limit (organization route catalog). The organization route has no
  workspace catalog, so its decoder gets only the organization's Claude
  models (read as the administrator; when they cannot be read, nothing is
  read live). A model only a workspace's catalog adds gets no family
  cooldown from an organization-route reading; its workspace's reads and
  refusal settlement still cool it, and no reading
  shortens a stored cooldown, so at most one request for such a model can
  be refused before it cools down. This narrows a quota hint, never
  authority.
- Throttle. The legacy 30-second refresh throttle holds. A stored
  usage-endpoint reading younger than 30 seconds answers first (this bound
  holds across replicas, but only while the newest stored observation is a
  usage-endpoint reading; a header observation replaces it, so for a
  connection serving traffic the bound is in practice per replica). Else
  this API process's remembered attempt (failed attempts included, kept in
  a bounded in-process map) answers when it is younger than 30 seconds and
  newer than the stored reading. The memory is keyed by organization,
  workspace (`organization` on the organization route), connection and row
  version, so a reconnect never replays an outcome of the old credential,
  and the three refresh paths share one rule. Another replica may read once more within
  the interval (accepted for this release: refresh is an explicit,
  scope-checked mutation of a read-only endpoint). The memory is per
  workspace, so the bound on live reads of one connection per interval is
  the replica count times the number of workspaces sharing that
  connection, not the replica count alone.
- Readiness. The Claude route is read once per request
  (`loadWorkspaceModelSelectionInput` and the models catalog pass it down).
  On the core route `loadWorkspaceClaudeSubscriptionReadiness`, the
  selection restrictions and the models catalog read the core eligibility
  projection (`listSubscriptionCoreServingConnections`: shared pools;
  personal connections only through the owner-only reader in the owner's
  own Personal workspace) and never a frozen v1 Claude snapshot. The
  legacy `{workspace, organization}` meaning is kept by pool:
  `organization-claude-subscription/` models are ready when a serving
  shared connection serves the organization inference pool;
  `workspace-claude-subscription/` models when one serves the workspace
  pool or the subject's own personal connection serves. Each prefix's
  restriction is the union of the allowlists of that pool's own assignment
  policies (null when any admits every model); a policy of the other pool
  never widens it. A serving connection's pools are its applicable
  assignment policies' inference pools, or, without assignment rows, its
  management classification (`workspace` when this workspace manages it,
  else `organization`). The not-ready answers are frozen values.
- Admission. On the core route the `claude_subscription` branch of
  `lockActiveOrganizationModelProviderCustomModelForAdmission` admits an
  organization model only when the transaction's subject was established
  by the caller (never a borrowed session creator or an inferred human for
  a service actor), and, for work accepted before this request, its
  carrier's accepted Claude authority admits it, and a live, allocatable
  shared connection serving the organization pool under the workspace's
  effective source admits the model; shared capacity only. Carriers:
  `session_initial` (session creation), `session_turn` (an edit, which
  carries its source turn's snapshot), `receiving_session` (agent-submitted
  work: the receiving session's execution-context turn, else its latest
  turn, else its initial authority) and `scheduled_task` (a task update).
  A human's own fresh prompt and a service actor's work carry none and
  take the source rule. The carrier is read through
  `read_subscription_authority_compat` (PR 0b, 0716): a compatibility
  record admits only when its shared pool is `organization`; a carrier
  without one (`v2` or `none`) takes the same source rule; anything else
  (`missing`, `v1`, not visible, or a database without the reader) admits
  nothing.
- Usage-reading completeness. The adapter declares `usageReadingsComplete`;
  the shared quota merge drops an omitted exhausted window only for a
  usage-endpoint reading of an adapter that declares it (see the usage
  bullets above and 2.2). Claude declares `false`. Each conformance suite
  states the value it expects and asserts it before branching, so a flipped
  or removed declaration fails its suite.
- Generalizations (provider-neutral): an optional `modelIds` on the probe
  deps and the `decodeQuota` input; `pools` on
  `SubscriptionCoreServingConnection` and `inferencePool` on its
  assignments; the adapter's `usageReadingsComplete` with the matching
  `applyQuotaObservation` option and the conformance expectation; `applied`
  on the probe's `read` result; and, copied unchanged from C2b, `version` on
  the shared connection row reads with the 0730 owner-only personal version
  reader (renumbered at merge). C2c uses the shared administered usage reads
  (5.3, "Administered usage reads"; the probe, 0735's owner-only routines
  and the shared operations steps), which land in their own
  provider-neutral PR before it.

##### C1b: Claude settlement, finalization and waits (implemented)

Built on X1b's shared refusal settlement, failover and core waits; dormant
like C1a.

- Classification. `classifyClaudeProviderError(error, modelId)` reads only
  errors of the Claude subscription transport (an `AnthropicRequestError`
  marked `subscription`, or a reconnect-required refresh): 401 or
  reconnect-required is `unauthorized`, 429 `rate_limited` with the turn's
  product model and the provider's retry time, 529 or `overloaded_error`
  `overloaded`, 403 `fatal`; anything else, a safety refusal or an
  API-key Anthropic error included, is not an account refusal.
- Settlement. A core Claude turn settles a refusal through the shared step
  (`settleCoreSubscriptionRefusal`) with Claude's binding
  (`claudeCoreRefusal(productModelId)`; the placed core turn carries the
  accepted product model). The transport already ran the turn's one forced
  refresh, so `unauthorized` becomes a sign-in quarantine; a 429 becomes a
  cooldown of that model on the connection until the provider's time or the
  adapter fallback (the connection keeps serving other models). Both record
  the core turn-failure receipt, which counts toward the shared per-turn
  bound, and re-place the same turn (reason `claude_credential_failover`).
  `overloaded` and `fatal` record nothing: a 529 continues in the generic
  provider-overload recovery (the same turn retries, the binding keeps its
  connection) and a 403 fails the turn without a rotation or quarantine.
  When a retryable failure arrives while a core Claude lane holds answered
  requests that still await their checkpoint (a paused search's
  continuation refused with a 529, or a tool or MCP failure after a
  complete response), settlement commits the history durably and
  checkpoints the main lane first (as the lease-lost and failover paths do), so
  the turn recovers; a main request still without its response stays terminal.
  Tool-less titles neither trigger this checkpoint nor block recovery, as in
  #4179. Codex and SuperGrok keep their existing main-lane gate (tested).
  An unknown request outcome or a lost lease skips the refusal step. The legacy
  Claude receipts, refresh recovery, rotation and wait never run for a core
  turn, and the core never reads the v1 `claudeAuthRecovery` marker (the
  receipts replace it); the claim keeps reading it for legacy turns until
  C3 converts live values.
  The binding declares `credential: { renewable: true,
  refreshedBeforeRefusal: true }`, so the shared plan never asks for a
  second refresh (one forced refresh per turn, as for a setup token, which
  cannot renew at all). A 429 without the accepted model is not settled
  (null) rather than widening to a whole-connection exhaustion. The refusal
  is fenced on the generation of the bearer the last admitted main-lane
  request carried (C1a's `mainLaneAdmitted`).
- Header usage. Each response's usage headers are decoded with
  `decodeSubscriptionCoreClaudeQuota`, using the refresh generation of the
  bearer that made the request and every Claude model of the deployment's
  catalog, and applied in order to the leased connection under the lease
  fence (best effort; every link of the chain is total, so the join never
  rejects). Finalization joins them before the lease is released, and so
  does the refusal settlement before it records the refusal and the
  failover releases the lease (the shared binding's optional
  `joinObservations` step): a 429's own headers, such as a rejected window
  with its reset, reach placement before the re-placement, and no write is
  dropped by the moved lease fence. One that ended a stored exhaustion
  wakes the account's Claude waiters (`quota_observed_available`), once per
  joined chain; the queued writes are awaited in full, while the wake
  delivery is bounded like a finalizer step and detached by the turn's
  cancellation signal (the capacity outbox is its backstop), so a stuck
  signal never holds settlement. The production finalizer must not wrap
  the queued-write join in detachable housekeeping: it retains the lease
  and its heartbeat until those writes settle, even after cancellation or
  the housekeeping deadline. A genuinely stuck join remains under the
  existing `provider_leases` finalization-stage watchdog, which requests
  graceful host drain and uses the host's exit backstop; it never fabricates
  completion or releases the lease early. This relies on the
  partial-reading fix of
  `applyQuotaObservation` (#4120), so C1b merges on a base that contains it.
- Waits. The core waiter accepts `claude` with the legacy Claude wait's
  vocabulary (`turn.capacity_waiting`, `turn.recovery.requested`,
  `turn.superseded`, status reason `claude_capacity`), and its workflow
  reference carries `provider: "claude"`. A Claude placement wait parks the
  same turn on the core waiter and re-evaluates it at once; a health
  recovery wakes the account's Claude waiters; the workflow reconciles a
  Claude reference against the core waiter by exact id and generation first
  (only a Claude core waiter), then the legacy Claude waiter. Compaction
  never parks (C1a). The shared conformance suite runs its session-wait
  scenarios for both Claude subjects.
  A Claude core waiter sleeps until its stored reset, as Codex's does
  (`recheckBeforeReset: false`): the Claude adapter reads no usage that can
  end an exhaustion early (its quota comes from response headers, so it
  does not declare `usageReadEndsQuotaExhaustion`), and its wait binding has
  no `refreshBeforeReconcile`. A header observation on another turn still
  wakes the waiter (`quota_observed_available`).
  Before the receipt a v1 Claude waiter lives in its own table: the exact-id
  core lookup finds nothing, so the v1 reconcile runs unchanged, and a core
  Claude wake fails closed while Claude is unregistered (a real-PostgreSQL
  test covers both). The false-resumption breaker's terminal code
  `claude_capacity_recovery_exhausted` joins the shared exhausted codes, so
  a human Retry replenishes it as for Codex and SuperGrok (legacy Claude
  never emits that code), and a core Claude turn's generic completed model
  request event carries `meaningfulOutput` (completed assistant text or a
  complete function call) so real progress resets the breaker.

##### C2b: routes and writers

Dormant until the Claude cutover receipt, like X2b: each Claude account
route, the setup-token and OAuth writers and the Claude access policy first
read the organization's `claude` provider route (one read). `legacy` (no
receipt, every organization today) runs today's handlers unchanged;
`maintenance` answers the typed 503 `subscription_core_cutover_disabled`,
including OAuth start and complete; `core` uses the neutral writers with
the `SUBSCRIPTION_CORE_CLAUDE` binding, which production does not register
until C3 (a test asserts it). Claude-specific code: the compat module
(`packages/db/src/subscription-core-claude-compat.ts`) and the API glue
(`apps/api/src/claude-subscription-core.ts`), under 500 lines together
including comments.

- **Pool routes.** Claude passes a core hook to the X2b pool routes (list,
  rename, allocator, activate, rotation, disconnect) with a
  `listedAccountJson` override, used by the two listings only, that adds the
  usage reading and the `needs_relogin` status the legacy listing derives
  from it; every other route (rename included) answers the plain legacy
  `accountJson`, as legacy does. Core rows project into the legacy
  `ClaudeSubscriptionAccountMetadata` shape (every field `accountJson`
  emits); the legacy quota columns and selection counters have no core
  counterpart and no Claude route renders them. Each account's `usage` is
  C2a's `projectSubscriptionCoreClaudeUsage` of its core quota row and
  provider state, so the listing keeps the legacy keys. The usage routes
  themselves are C2a's.
- **Version.** A Claude account has one credential version on the core:
  the core connection's row version. It is the listing's `version`, the
  listing's `usage.credentialVersion` (the web client treats a difference as
  a credential change and reloads), the setup-token
  `expectedCredentialVersion`, the OAuth attempt's `credentialVersion` and
  the responses' `credentialVersion`. It is a positive integer for every
  listed connection; a row without one fails the listing rather than
  listing a made-up version. It moves on connect, reconnect, rename and
  every status transition (the 0707 `needs_relogin` refresh-failure
  writers, quarantine and health recovery), never on a successful refresh
  (that moves `refresh_generation` only, which would otherwise make a replace
  flaky). Legacy moved its credential version only on a credential write,
  so on the core a replace or an OAuth reconnect whose account was renamed
  or changed status after it was read (an OAuth sign-in can take up to 10
  minutes) answers the legacy 409 and writes nothing; the person reloads
  and starts again. That is stricter than legacy, never weaker, and was
  accepted (confirmed decision; a test pins it). The refresh generation
  stays internal for usage staleness. C2a's usage routes report the same
  row version. Personal rows are read through the
  owner reader, which does not return the version, so migration 0730
  (designed here, carried by C2a, which merges first) adds
  `opengeni_private.subscription_core_personal_connection_versions`,
  derived from the live owner reader (0707, as 0715 rewrote it) by
  drift-checked replacement (the 0728 pattern) and returning only
  `(id, version)`. A schema test compares the two live bodies outside the
  patched name, `RETURNS` and `SELECT` parts, so a later fix to the owner
  reader must reach the version reader too. The workspace listing reads the
  rows and their versions in one snapshot (repeatable read), so a
  concurrent disconnect cannot leave a listed personal row without a
  version.
- **Reconnect.** The neutral connect writer takes an optional
  `reconnect {connectionId, expectedVersion}`: the sign-in must land on
  exactly that connection at that version, or nothing is written and the
  route answers the legacy 409. A reconnect never creates a connection. For
  a shared row the writer checks under its row lock; for a personal row the
  0728 writer serializes and moves the version by exactly one, so the
  writer reads the version back and rolls the whole write back unless it is
  the target at `expectedVersion + 1`.
- **Identity.** A core connection's Claude identity never changes. The
  provider account id is the legacy one (the account uuid, else the
  `oauth:`/`setup:` HMAC id), and it is also the provider subject id (the
  Claude account is the person's own login). A credential that proves an
  account (an OAuth sign-in with an account uuid) reconnects only that
  account. One that proves none (a setup token, or OAuth without a uuid)
  keeps the target's unverified id, so replacing a setup token whose HMAC
  changes keeps the account, its pins and policy; it never replaces a
  target whose account was proven. A proven sign-in over any unproven
  target (a setup token's `setup:` id, or an earlier sign-in's `oauth:` id
  without an account uuid) is refused too, where legacy upgraded the row in
  place: re-keying a core connection could merge it with another
  connection of that account, so the person adds the signed-in account and
  disconnects the old one. Legacy also let a setup token replace a proven
  account; the core refuses it. Each refusal has its own short copy: a
  sign-in over an unproven account (`sign_in_over_unverified`), "This
  account was added without a verified sign-in. Add it again with Sign in,
  then remove the old one."; a setup token over a signed-in account
  (`setup_token_over_sign_in`), "A setup token can't replace a signed-in
  Claude account. Add it as a new account."; any other account
  (`different_account`), the legacy "Sign in to the same Claude account to
  reconnect. Use Add account for a different subscription." (Confirmed
  decision: no in-place upgrade between setup-token and OAuth identities.)
- **Connect.** Shared and personal connects store the legacy secret object
  through the adapter codec, with the adapter's format
  (`claude_oauth_v1` with `oauth`, else `claude_setup_token_v1`) and the
  adapter-owned provider state `{oauthScopes}` (`[]` for a setup token),
  the expiry the adapter reads from the credential. As for SuperGrok, an
  organization or workspace connect creates a shared connection (a shared
  workspace's is an organization account that workspace manages), a new
  shared account needs an organization administrator, and a first connect
  leaves the primary unset (confirmed decision). `offerClaudeDefaultModels`
  runs after every core connect, as legacy; waiters wake through
  `deliverPoolCoreWake` (the OAuth writer passes only the binding).
- **Personal.** `scope: "user"` connects only in the person's own Personal
  workspace. The setup-token route and OAuth start and complete read the
  `claude` route first (the `workspace:read` grant naming the organization
  is taken only once a receipt exists, as for SuperGrok, so legacy
  authorizes exactly as before: a test connects a shared setup token with
  `workspace:admin` and no `workspace:read`), then on the core
  refuse a private connect anywhere else with 403 before any sign-in
  starts (`requireClaudeCorePersonalWorkspace`) and authorize the private
  human with X2b's `personal_workspace` place, as the shared pool routes
  do, so the owner connects, lists, renames, reconnects and disconnects
  there (a Personal workspace has no ordinary membership, which legacy's
  `ordinary_workspace` place requires). Another member's Personal workspace
  is not visible to the person (404). The 0728 writer checks the exact
  owner membership and authority generation in its transaction; a personal
  sign-in completed elsewhere is refused 403, never turned into a shared
  connection. On legacy the routes keep `ordinary_workspace` after the same
  one read.
- **OAuth attempts.** An attempt records the runtime it started on (a core
  attempt carries `runtime: "core"`, names the canonical connection and its
  row version and no v1 authority snapshot) and completes only on that
  runtime: an attempt started on the legacy path (adding or reconnecting)
  and completed after the cutover, or the reverse, answers 409 "Claude
  account changed during sign-in. Start again." with nothing written, as
  does any change to the target in between. An older pod's strict attempt
  schema rejects the new key (410, start again), which fails closed too.
- **Access policy.** `claude_subscription` reads and writes the core
  connection's policy (`subscriptionCoreProviderOfKind`), the legacy
  snapshot check is skipped on the core as for SuperGrok (the core editor
  authorizes; only legacy pools have private rows), a workspace change
  keeps the legacy same-origin browser check, and a change wakes waiters
  with `core_claude_access_changed`.
- **Aliases.** Route account ids and reconnect targets (setup token and
  OAuth) resolve through the cutover aliases with X2b's
  `canonicalConnectionId` (`resolveSubscriptionCoreRouteConnectionId`): in
  the organization context aliases resolve for organization administrators
  only (hence the authenticated subject); in a workspace context, for the
  connections visible there; a personal account's legacy id only for its
  owner in their Personal workspace. Activate answers the canonical id
  (X2b). Access-policy ids need no route-level translation: the core access
  editor resolves aliases itself.
- **Acceptance (EP-S18..S24) and copies.** Nothing Claude-specific was
  needed: once Claude is registered the merged `coreSubscriptionAuthorityV2*`
  writers add the `claude` entry for the exact owner only, the generic v1
  resolvers return the column default after the `claude` receipt, and the
  compatibility copy writes Claude records on every carrier path (both
  covered by real-PostgreSQL tests).
- **SDK and events.** No change: request and response shapes, status
  reasons and SDK types are the legacy ones; core wakes carry the neutral
  reasons. Session-event vocabulary on the core is C1b's.

Generalizations (provider-neutral): the connect writer's `reconnect` fence,
`returnVersion` and the connected result's `version`; the `changed`
refusal; `SubscriptionPoolCore.listedAccountJson`; `deliverPoolCoreWake`
takes only the binding. `SubscriptionCoreConnectionRow.version` and
`readSubscriptionCorePersonalConnectionVersionsInTransaction` (0730) were
designed here and are carried by C2a.

#### C3: the drained Claude cutover

Migration 0741 (`-- deployment-mode: maintenance`) is the Claude counterpart
of 0740 and follows "Data mapping", "Accepted authority across the
cutover", "Personal authority generations" and "Cutover protocol" above.
The runbook is `docs/deployment.md`, "Claude on the shared subscription core
(0741)". It reuses X3's machinery rather than forking it: the receipt,
registry row, readiness, `subscription_cutover_report`, compatibility
records, the neutral planner and `subscription-core/cutover-stage.ts`. C3
generalizes the pieces X3 had inline: the migrator runs every provider's
codec stage from one `PROVIDER_CUTOVER_STAGES` list (`migrate.ts`), and the
stage's error, plan-context and conflict helpers move into
`cutover-stage.ts`; the SuperGrok stage uses them unchanged in behaviour.
The Claude stage (`packages/db/src/claude-subscription-core-cutover.ts`)
holds only the Claude row shape, identity rules, usage mapping and catalog.
Choices made where the plan left room, for reviewers:

- **Provider-keyed pins.** C3 requires the `(workspace_id, session_id,
  provider)` primary key and enabled
  `subscription_session_bindings_provider_fixed` trigger. After both drain
  checks it drops the rolling session-only index with `IF EXISTS`, before
  any binding write or activation, and never disables that trigger.
  `pool_in_effect AND eligible` is the complete move predicate: current
  model and foreign bindings neither suppress nor displace a Claude pin.
  The `other_provider_session_bindings` parity metric compares every field
  of each pre-existing foreign row, including choice, version and cache
  clock. `pin_other_provider_binding_kept` is no longer a Claude disposition.
  The combined-provider regression keeps Codex and SuperGrok rows beside
  Claude on the same sessions, with both explicit and automatic choices.
  The precursor must precede X3 as well as C3 in the integrated ledger;
  the combined-window ledger test refuses a stack that violates that order.
- **Format.** The legacy plaintext is copied unchanged; the stage writes
  `claude_oauth_v1` for a secret with `oauth` and `claude_setup_token_v1`
  otherwise, the formats the adapter derives at runtime (as 0740 writes
  `xai_oauth_v1`). The column is informational: no decision reads it, the
  adapter derives the format from the decrypted secret, and the shared
  connect and reconnect writers record the envelope version `v1`, so a
  Claude row's value tells a migrated row from a newly connected one.
  Recording the adapter format in the shared writers is a possible
  follow-up outside C3.
- **Identity.** The person is the token's `identity.accountUuid`. A stored
  `provider_account_id` of the form `oauth:<hmac>` or `setup:<hmac>` (the
  connect writers' derived id when the token reports no account) is its own
  person key; any other stored value must equal the token's account, else
  `provider_identity_mismatch` aborts. OAuth and setup-token rows never
  merge, even for the same Claude account: they renew differently, and one
  must not inherit the other's needs-relogin state.
- **Usage.** Only a usage row of the credential's current version is read.
  Its windows, request restrictions and per-model cooldowns map through
  `decodeSubscriptionCoreClaudeQuota`, cooldowns re-keyed from upstream ids
  to product ids under both Claude prefixes; an alias's live cooldowns join
  its canonical connection's, ended ones are dropped. The observed refresh
  generation is the credential version. The legacy `exhausted_until` becomes
  a `quota` exhaustion only when there is no current reading (the reading
  decides otherwise). A stale row (`usage_rows_stale`) or an undecodable
  current row (`usage_snapshot_unreadable`) leaves usage unknown, which the
  `usage_generations` parity metric counts as matching. The quota keeps
  Claude's `refreshStatus` and `refreshCheckedAt`; a pending `reconnect` is
  the `usage_reconnect_pending` disposition and never changes the
  connection status (the next refresh decides).
- **Catalog.** Cooldown re-keying and family limits use each organization's
  catalog at the cutover: the default Claude models plus the organization's
  and its workspaces' `claude_subscription` custom models that are not
  retired.
- **`claudeAuthRecovery`.** A live turn's value (`{credentialId,
  credentialVersion}`, the one forced refresh it already spent) was kept per
  credential by legacy. When it names the canonical credential of its moved
  connection at that connection's current refresh generation it becomes an
  `unauthorized` row in `subscription_turn_failures` for the turn and
  connection, with evidence `{refreshGeneration: credentialVersion,
  refusals: 0}`: the audited record of the renewal, which is not a refusal
  and does not use the turn's failover bound
  (`countSubscriptionCoreTurnRefusals` sums `refusals`). A value naming a
  duplicate login (now an alias) or an older version is not about the
  connection's current credential and writes no receipt
  (`auth_recovery_not_current`), so a receipt never stands for another
  credential's renewal. On the core, C1b's Claude transport runs the forced
  refresh itself and settles a 401 after it as a sign-in quarantine, and no
  core decision reads the old marker. Finished turns are
  ignored; a value naming no moved credential is `auth_recovery_unmapped`, a
  malformed one `auth_recovery_malformed`. The metadata stays as history.
  (Review of #4137 found the first version attached an alias's renewal to
  the canonical connection and counted it as a refusal.)
- **Legacy model connections.** 0598 revoked and blanked every legacy
  Claude model connection (`connections` with `credentialRole =
  claude_subscription`, `organization_model_provider_connections` with
  `provider_kind = claude_subscription`). Revoked ones stay untouched; one
  that is not revoked or still holds a secret aborts
  (`legacy_connection_not_revoked`), because the cutover would leave that
  credential behind.
- **Organization locks, Steer and Cancel, read-only legacy.** No
  workspace override of a locked key is written and each such workspace is
  listed. The drained-role preflight and owner window's `ACCESS EXCLUSIVE`
  locks on `subscription_settings` and the other moved relations protect
  the organization-lock reads and override writes until commit. Fence-checking
  triggers are disabled and restored in that window, while the provider-fixed
  trigger stays enabled. C3 takes no settings advisory locks after those table
  locks: runtime writers take fences first, so a later wait would invert their
  order. READ COMMITTED, Personal-workspace fallback handling, locked-key skips
  and their parity checks remain required. The Steer path no longer supersedes legacy Claude waiters (core
  cleanup only); Claude's six legacy tables, including
  `claude_subscription_account_usage`, join
  `SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES` with restrictive
  `<table>_closed_insert` and `<table>_closed_update` policies (write
  commands only: a restrictive policy that also covered SELECT would make
  the lifecycle-facts backfill of 0565 refuse the table), and the legacy
  disconnect refuses after the receipt.
- **Together with SuperGrok.** 0740 and 0741 share no legacy table or key,
  so one migrator run applies both in ledger order, each in its own
  transaction with its own report and readiness gate; a Claude abort leaves
  0740 committed and a rerun resumes at 0741. The combined-window ledger
  test (`subscription-core-combined-cutover-ledger.test.ts`) proves this
  and that only rolling migrations lie between them.
- **Merge gates as ordinary tests.** The Claude seam integration test's
  peek and reconcile cases need C1b's Claude core waits, and the 0741 test's
  "a newer Claude usage reading that omits a still-exhausted window" case
  needs C2a's `usageReadingsComplete: false`. They are ordinary tests, red
  until those land in the base, so C3 cannot pass its exact-head validation
  (and so cannot merge) ahead of the Claude core runtime. The response-header
  variant of the usage case passes on #4120 alone.

#### R: retirement of the legacy pool routines and the Codex twins

R is the last M4 step. Its drained maintenance migration
`0744_subscription_core_legacy_retirement.sql` runs after both provider
cutovers (0740, 0741). It drops the legacy decision routines of the 0234 and
0598 pool factory, the triggers and policies that call them and the
Codex-named twins of the 0707 neutral routines, each by exact name and
signature and never with `CASCADE`, and it finalizes the provider-keyed
reach rows (0713 note "Kept until retirement"). The whole file is one
transaction. Runbook:
[deployment, subscription legacy retirement (0744)](../deployment.md#subscription-legacy-retirement-0744).

- **Preflight.** It changes nothing and refuses with a content-free `55000`
  unless: the migrator passed the application roles, and neither they nor
  any other connected non-superuser login that could execute a retired
  routine or write an affected table has a session (drained). This includes
  privileges reachable through transitive `SET ROLE` membership, even for
  `NOINHERIT` logins and before they switch roles; the cutover receipt of every registered
  provider (`codex`, `xai`, `claude`) is committed
  (`opengeni_private.subscription_provider_cutover_committed`); every
  retired routine exists with its exact signature and no other overload of
  its name exists; every retired policy and trigger exists on its table, and
  each trigger calls its listed function; the reach table, its view, its
  default and the connections' key are as 0712 and 0713 left them; and the
  reach routines, triggers and policies exist under their Codex names only.
  Then it refuses with `2BP01` if anything that stays depends on a retired
  object. It checks `pg_depend`, then searches every kept routine body
  (PL/pgSQL `prosrc` and SQL-standard bodies), policy expression, trigger
  `WHEN` clause and arguments, view definition, column default and `CHECK`
  constraint for a retired name or a Codex reach name. It matches the name
  written literally or built at run time around its provider token, as a
  `format()` pattern (`'resolve_%s_authority_pool'`) or as concatenated
  literals (`'resolve_' || provider || '_authority_pool'`), including
  tagged and untagged dollar-quoted fragments. Matching is case-insensitive
  so unquoted uppercase calls cannot evade the check. This also
  covers the SQL that X4 and C4 leave deciding on stored v1 values
  (`admit_scheduled_agent_run_execution`,
  `record_scheduled_task_revision_authority` and their peers): none calls,
  names or builds the name of a dropped routine, and the 0744 suite asserts
  that they are unchanged.
- **Drops, dependents first.**
  - 21 policies: each provider's `*_subscription_scope` and four
    `*_subscription_pool_scope`, `claude_usage_account_scope`, and the
    capability policies. On `organization_memberships` these are
    `*_subscription_capability_read` and `*_subscription_membership_lock`;
    on `organization_user_resource_authorities` they are
    `*_subscription_capability_insert`, `_read` and `_revoke`.
  - 14 triggers. Per provider: the credentials' authority-immutable,
    organization runtime-update and live-disconnect guards; the rotation
    table's organization rotation and pool-reference guards; and the lease
    and pin pool-reference guards.
  - 42 routines:
    - per provider, `create_*` and `disconnect_*_subscription_credential`,
      `resolve_*_authority_pool`, `revalidate_*_subscription_authority`,
      `*_subscription_authority_live`, `*_subscription_pool_visible`,
      `prevent_*_authority_mutation` and the three `opengeni_private`
      trigger functions;
    - the 19 Codex twins;
    - the owner-only writer context, which four of the twins call, and the
      owner-only connection target;
    - 0689's `apply_subscription_codex_auto_assignments`, which nothing has
      called since 0713.
- **Reach finalization.**
  - 0713's owner-only view goes, and the table
    `opengeni_private.subscription_codex_auto_assignments` takes its name,
    `subscription_core_auto_assignments`. The neutral routines that read the
    view need no change.
  - A foreign key `(account_id, provider, connection_id)` to
    `subscription_connections (account_id, provider, id)` (the key 0712
    added) is added `NOT VALID` and validated, so a reach row can no longer
    name another provider's connection. A mismatch refuses the migration
    with `23503`. The column loses its `codex` default.
  - 0689's two auto-assignment triggers, its plan-change trigger, their
    functions, its two owner-only auto-assignment policies and their setting
    (`opengeni.subscription_core_auto_assign`) take provider-free names.
    `core` sorts where `codex` did, so the firing order is unchanged.
  - The three renamed functions end owner-only. provision-roles grants
    every `opengeni_private` function and then revokes the owner-only ones
    by name, so the migration revokes them from PUBLIC and every other
    grantee, and provision-roles now revokes them by their new names.
  - The reach table's 0689 constraint and index names stay. They name no
    routine, and nothing reads them.
- **Kept, with reasons.**
  - Historical migrations, and the legacy tables and columns (until M6).
  - The v1 validators, the column-immutability functions and triggers, and
    `reject_legacy_claude_subscription_credentials` with its triggers.
  - Every receipt function, including
    `opengeni_private.claude_subscription_pool_protocol_v1_active()`. It is
    0598's protocol receipt and no longer a readiness requirement; dropping
    it would gain nothing.
  - The X3 and C3 `*_closed` restrictive policies.
  - The live Codex routines: the refresh-write check, the five Apps
    routines, the reset authority and credit fence, the owner capability and
    membership checks, the owner capability grant and drop, and the cutover
    receipt routines.
  - `list_organization_codex_workspace_ids`. The legacy organization pool
    wake still calls it on R's base; X4 and C4 remove that caller, and a
    later migration can drop it.
  - The two `opengeni_private.*_subscription_runtime_capabilities` tables,
    until M6. Nothing reads or writes them once their policies and routines
    are gone, and dropping tables is M6's job.
  - Without a permissive policy, the factory tables keep FORCE RLS and deny
    the runtime roles every row: the intended read-only end state until M6.
- **Runtime posture.**
  - `runtime-posture.ts` exports the retired routine, policy and trigger
    lists and the renamed routine, trigger, policy and relation lists
    (`SUBSCRIPTION_RETIRED_*`, `SUBSCRIPTION_RENAMED_*`). The guard and the
    real-PostgreSQL tests share them.
  - The posture requires every retired object, and the Codex name of every
    renamed one, to be absent. This replaces #4128's twin tolerance and the
    SuperGrok and Claude routine and grant requirements, and
    `claude_subscription_pool_protocol_v1_active` is no longer a readiness
    requirement.
  - So the R release refuses a database that has not run 0744, and every
    older release refuses one that has, because its posture requires the
    dropped routines.
- **provision-roles** derives conditional owner-only revokes from the shared
  retirement inventory, including the writer context, connection target,
  apply routine and renamed trigger functions' old names. They run in the
  same atomic block as the private-schema grants: provisioning before
  retirement cannot expose those helpers. After retirement the conditional
  revokes are no-ops; the renamed trigger functions are revoked by their new
  names.
- **Reach validation.** The schema owner briefly removes FORCE RLS from
  `subscription_connections` only inside the transactional foreign-key
  validation window, then restores it. This lets a restricted migration
  owner validate populated reach rows without runtime visibility filtering.
  A failed validation rolls back the window too. Tests cover valid populated
  reach and mismatched providers as a NOSUPERUSER, NOBYPASSRLS owner.
- **Guard.** `scripts/legacy-subscription-runtime/pool.ts` (`pool`) rejects:
  - the synthetic subjects (`subscriptionPoolWorkerSubject`,
    `isSubscriptionPoolWorkerSubject`, and `worker:<provider>-workspace` in
    any spelling);
  - every retired routine name, from the shared list;
  - the `"<legacy routine>".replace("xai" | "claude", provider)` shapes;
  - `withSubscriptionPoolSessionAccess` and
    `withTemporaryPoolSessionAccessInTransaction`;
  - runtime imports of the `pre-retirement-grants` historical fixture.

  Its only exceptions are exact declarations: the posture inventory and the
  historical `moveCodexCredentials` migration codec. Test files are outside
  runtime scanning, but importing their historical fixture into runtime is
  forbidden.
- **Synthetic subjects.** The synthetic pool-worker subjects and pool-only
  session-access helpers are removed from production with their X4/C4 callers.
  Their historical test fixture retains the original private-session regression
  coverage; the guard forbids importing it into runtime code. The neutral
  waiter wake helper remains: it performs bounded invalidation, restores the
  caller's context and grants no authority to run or read another session.
- **Fresh install.** A fresh database replays every migration. 0689 seeds
  the Codex receipt, and 0740 and 0741 commit theirs on an empty database,
  so the preflight passes unchanged; no fresh-install exception weakens the
  upgrade check.
- **#4128 notes.** The twins could be dropped only once the release
  containing #4128's twin tolerance was the minimum running one. A drained
  window guarantees that, because only the R release starts afterwards. The
  drop is one transaction, so no partially retired database can exist.

### 5.4 Workspace-managed connections as organization accounts

Owner request (M4 addition): an account connected in a workspace, which the
organization Accounts page shows as "<workspace> only", becomes an
organization account like any other, so an organization administrator can
give it to the whole organization, chosen workspaces or chosen people through
the access editor (0702), without reconnecting. Credentials, pins, settings
and live waits are preserved, and nothing widens access to private sessions
or personal accounts.

#### What blocked it

The data is already organization-owned. Since 0689 (§5.2, first row) a
legacy workspace credential in a shared workspace is a `shared` connection of
the organization (`account_id`), with `scope_kind = workspaces` over that
workspace, one assignment-policy row `(workspace, inference_pool = workspace)`
carrying its allocator, model allowlist and manager, and
`managed_by_workspace_id` naming the workspace; a core connect from a shared
workspace creates the same shape (an organization administrator's decision,
SUB-OWN-01). `managed_by_workspace_id` is delegated management (SUB-OWN-04,
§3.1), not ownership, and `connected_by_subject_id` is audit only
(SUB-OWN-07). What kept such a connection out of the organization's reach
editor were projections and route filters that read "managed by a workspace"
as "not an organization account":

| Layer | Gate |
| --- | --- |
| SQL | `set_subscription_codex_reach` (0702) and, from PR 0c (0713), the provider-keyed `set_subscription_core_reach` it delegates to accept only `managed_by_workspace_id IS NULL`, so saving any organization choice failed for a managed connection. |
| Access editor | The organization target of `getSubscriptionCoreCodexModelConnectionAccess` / `update…` selected only connections no workspace manages (404 otherwise), and its projection listed only organization-pool assignments, so a workspace's own copy was invisible to it. |
| Organization routes | Allocation, rename, primary, extra credits, disconnect, usage and reset-credit inspection on the organization route resolved only connections no workspace manages (the primary keeps that rule, decision 10). |
| Organization pool list and web | `readSubscriptionCoreOrganizationPool` lists only those connections; the Accounts page lists a workspace's own accounts as "<workspace> only" rows that open the workspace's page, where no reach can be chosen. A connection 0689 deduplicated across two workspaces (manager NULL, two local copies) appeared twice: once as an organization account and once per workspace. |

#### Decisions

1. **Organization-owned means administered by the organization.** Every
   shared subscription connection, whether or not a workspace manages it, is
   an organization account: listed among the organization's accounts, opened
   on its organization page and edited through the same access editor. Only
   the organization routes and projections change; ownership, scope and
   management columns keep their meaning.
2. **No row moves; the change is rolling.** The former workspace account is
   already in the target shape, so its initial reach equals its current reach
   with zero writes: `workspaces` scope over its workspace, no Personal
   workspaces, its local assignment policy (classification `workspace`, its
   allocator and models, its manager), no reach for workspaces created later.
   Credentials, refresh generations, quota, aliases, bindings and pins,
   leases, waiters, wake revisions, settings, primaries, Apps designations and
   accepted authority are not touched. The owner asked for a drained,
   parity-checked move like 0689; that protocol exists to move and re-encrypt
   rows that old binaries would otherwise write concurrently. Here nothing is
   rewritten, old binaries read the same rows with the same meaning, and the
   SQL changes of migration 0714 (the two reach setters also accepting a
   connection a shared workspace of the organization manages, the reach
   reader also reporting the reach row's switch and model list, and the new
   organization-administrator routine `set_subscription_core_reach_allocator`,
   which this release's API calls on every organization rotation switch and
   access save) only admit calls older binaries never make or add keys they
   ignore. A maintenance migration would
   move zero rows, so its parity report would compare every table with itself;
   the evidence is instead a real-PostgreSQL test
   (`migration-0714-workspace-managed-organization-accounts.test.ts`) that
   applies 0714 as the owner to a database migrated without it and finds
   every subscription row identical (aliases, bindings, waiters, leases and
   Apps designations included), plus the read-only inventory the runbook
   compares before and after the release and a per-table digest for a
   rehearsal on a restored backup (the parity check without a drain). A
   managing workspace's plain assignment without policy rows, an older shape,
   is also its own copy: organization saves keep it and add no
   organization-pool row to it, which would make placement read it as the
   organization's. It needs no window, and it can ship alone or in
   the same release as the SuperGrok and Claude cutovers, in either order.
3. **The managing workspace keeps its copy.** The 0702 rule stands: a
   workspace's own copy (its `workspace`-pool assignment policy) keeps its
   assignment and row whatever the organization chooses for workspaces. The
   editor reports these workspaces (`localWorkspaceIds`) so the form shows
   them as included and cannot clear them; `allowedWorkspaces` keeps meaning
   organization-pool grants only, so an older form that never saw the field
   saves exactly what it saves today. Choosing "all workspaces" or the whole
   organization adds an organization-pool row for the managing workspace
   too, as for any mixed connection after 0689, so a workspace whose source is
   `organization` then also uses it: the administrator granted it. Explicit
   `workspace` and `organization` source modes therefore select exactly the
   same accounts as before until an administrator changes the reach.
4. **Chosen people.** The editor gains the third scope of SUB-OWN-02 for
   organization accounts no workspace manages (decision 5 explains why a
   managed one is not offered it): `allowedPeople` (organization membership
   ids of active people, read
   through the administrators' member list; adding a service account or a
   person who has left is refused, while a person already chosen who has
   since left may stay listed and is not served, since people scope admits
   only active memberships). A people-scoped connection
   serves only sessions whose owner is a chosen person (§3.8), in any
   workspace that person uses (except one set to use only its own accounts,
   whose source excludes it) and in their Personal workspace, and never an
   ownerless session (SQL and placement already refuse people scope there).
   Choosing people removes the organization-pool rows and the reach for
   workspaces created later; local copies keep their rows, which serve again
   when the reach includes workspaces, but under people scope only chosen
   people's sessions in that workspace can use the account. A save without
   `allowedPeople` while the scope is people is refused as a stale form
   (409), so an older form cannot silently replace people with workspaces.
   That guard lives in the API, so older API pods during a rollout bypass it:
   the runbook forbids people choices until every pod runs the release.
   People are offered only when the organization's member list can be read
   (at most 1000 memberships, revoked ones included, its existing limit; the
   database refuses larger organizations with SQLSTATE 54000, which the
   editor's read treats as "people not offered"). Otherwise the editor works
   without the people choice: an account that already has people there can
   keep or drop them and have its models edited, but adding someone is
   refused (422), since nobody added can be checked against the list.
5. **Delegated management is unchanged.** The managing workspace's
   administrators keep exactly what they can do today: reconnect, rename,
   allocation, the models of the account from their workspace (0702), the
   Apps designation in their workspace, usage-limit resets, and their
   workspace's source, rotation and primary. They gain nothing: scope and
   reach stay organization-administrator decisions (scope guard), they cannot
   manage the account from another workspace (the update, assignment and
   designation policies require the current workspace to be the manager),
   and they see no other workspace's assignments. This is the strictest
   choice that does not take a current ability away from them. Consequence,
   recorded for the owner: because these actions act on the one connection,
   a delegated manager's switching off, narrowing of models, extra credits
   and a reconnect also apply where the organization later shares the
   account; switching on and widening models reach only the manager's own
   copy.
   The organization's choices for the workspaces it shares the account with
   live where only organization administrators write: the
   organization-pool rows and the reach row for workspaces created later
   (placement requires both the connection's and the workspace assignment's
   allocator and models). So "every workspace" for a workspace-managed
   account is stored as every workspace's organization-pool row plus that
   reach, never as `organization` scope, which only the connection's own
   values would bound. Each route flips its own switch: the organization's
   (the connection's switch with its organization-pool rows and the reach
   row) or the managing workspace's (the connection's switch with its own
   row). Each page shows what serves: the organization's page the
   connection's switch with the organization's copies; a workspace's page
   the switch placement reads for its source (its own copy, the
   organization's copy, or under the automatic source either). When the
   managing workspace uses the organization's pool and the organization has
   paused its copy, its page reads off and its own "on" changes nothing it
   can change (fail closed): only the organization turns its copy on. A
   request is "unchanged" only when every part its
   route writes already has the value; otherwise it writes all of them, so
   an "off" is recorded on that side's copies even when the other side has
   already switched the connection off, and the other side's later "on"
   cannot serve where this side said off. The connection's switch gates
   every copy, so either side can switch the account off everywhere, but
   switching on reaches only that side's copies. An account no workspace
   manages is the organization's alone: its route shows the connection's
   switch (as the shipped organization page always did) and its "off" turns
   every copy off, including copies 0689 merged with their organization
   copies paused; the editor gives copies it adds, and the reach, the
   connection's switch too. A workspace-managed account switches only on the
   organization's route and the managing workspace's: another workspace's
   route would switch the connection alone, which the manager's next "on"
   would undo for every other workspace, so it is refused as not found (that
   workspace's page opens the organization's page for it). Older API pods
   still switch the connection alone there, so the runbook forbids sharing a
   workspace-managed account until every pod runs the release, and asks for
   such accounts to be narrowed back before an older image runs again. An
   older pod's workspace route also decides "unchanged" from the connection's
   switch alone, so after the organization switches on an account its
   managing workspace had switched off, the workspace's "on" there is lost;
   the runbook lists such accounts before a rollback.
   Until a workspace-managed account is first shared it has
   no organization copies, so the organization's switch is the connection's,
   which its managing workspace also flips; the organization's choice is
   recorded on its copies from the first share on (new copies take the
   organization's switch, or the connection's while there were none). The
   organization's switch and model list are read from its copies, the reach
   row included, so a reach row without organization-pool rows (its
   workspaces deleted) still holds the organization's values. Narrowing a
   workspace-managed account back to its managing workspace alone removes the
   organization's copies, so its "off" is not kept: the account is then
   unshared, its organization switch reads the connection's again (which the
   managing workspace also flips), and a later share takes that value. The
   organization administrator sees that value on the account's page before
   sharing it again.
   The organization's switch sets the reach row's switch alone (0714's
   `set_subscription_core_reach_allocator`), since the reach setter would
   also copy the connection's model list, which the delegated manager
   writes. An organization save sets the model list for every copy,
   including the managing workspace's own; that workspace may change its
   own copy's list again, which narrows but never widens the others. So a
   delegated manager can narrow another workspace's use but never widen it;
   extra credits are the exception, since they are one per-connection
   switch. Whether sharing beyond the managing workspace should narrow the
   delegation is an open question below.
   People scope is therefore not offered (`peopleSupported: false`) and is
   refused (422) for a connection a workspace manages: the managing
   workspace's administrators see and manage the connection through its
   workspace assignment (connection visibility for `people` scope requires a
   chosen person's session), so limiting it to people would take reconnect,
   rename, allocation and models away from them. Copies 0689 merged (no
   manager) can be limited to people; their workspaces keep their own copy
   rows, used only by chosen people's sessions while the scope is people.
   Whether people scope should be allowed for managed connections, and what
   then happens to the delegation, is an owner decision (open question below).
6. **Personal accounts are untouched.** Personal connections are never
   listed, read or written by the organization editor (it selects `shared`
   rows only, and the scope guard forbids changing `ownership`); widening a
   personal connection (SUB-OWN-06) is a separate flow. Fail closed: a shared
   connection managed by a Personal workspace cannot be produced by any
   writer (Personal-workspace connects create personal connections, 0689 maps
   Personal-workspace rows to personal ones), but if one existed the
   organization editor and routes would treat it as not found; the runbook
   query counts them (expected zero).
7. **Pins, leases and waits.** Bindings stay; a reach change that makes an
   explicit choice unusable for the session leaves it waiting
   `pinned_account_ineligible` (D-24) until the reach includes it again. A
   transferred or running lease finishes only its already-authorized call;
   renewal, the next call and waiter recovery recheck the live reach (core,
   unchanged). Every save delivers the account-wide wake after commit, so
   work that a wider reach can now serve is placed without waiting for its
   recheck.
8. **Aliases and Apps.** Route ids resolve through aliases as before. Apps
   designations stay where they are and keep 0688's target rule: a
   workspace-managed account can be designated only in its managing workspace
   (by that workspace's administrators or an organization administrator), an
   unmanaged one by an organization administrator in any workspace (D-20).
   Designating a workspace-managed account in another workspace it now
   reaches is not added here: it would redefine the 0688 designation routine
   and is left to the owner (open question).
9. **Provider-neutral.** The access editor for core connections moves into
   the shared core (`subscription-core/access.ts`), keyed by the provider
   binding: SuperGrok and Claude reuse it when their access routes read the
   core (X2b, C2b). The Codex functions stay as thin wrappers with unchanged
   names and shapes.

10. **Delivery.** The backend change (this migration, the neutral editor,
   people, and the organization routes for allocation, rename, extra credits,
   disconnect, usage and reset credits resolving every organization account)
   ships first and changes nothing a shipped page shows, because the
   organization Accounts list still lists only unmanaged accounts and no
   shipped page opens a managed one on the organization route. One
   correction is visible: under the automatic source a workspace page shows
   an account on when any of its copies there is on, which is what placement
   serves (it showed only the effective pool's copy, so an account 0689 left
   with a paused copy next to an enabled one could read off while serving).
   The organization page's switch turns such an account off, as before. The
   organization pool list (`readSubscriptionCoreOrganizationPool`) and the
   Accounts page and editor change together in the UI change, which awaits
   the owner's approval of its preview: listing managed accounts without the
   page change would show each twice, once with a misleading reach.
   The UI change also makes the pages decide "own" from data the server
   already computed: the organization list's `ownInWorkspaceIds` (workspaces
   using each account as their own copy) and the workspace pool's
   `workspaceSetAside` (some own connection is outside the effective pool)
   and `organizationCount` (shared connections other than the workspace's
   own that reach it; people-scoped ones aside), so rows, counts, the notice
   and the "set aside" rows agree for administrators and workspace
   administrators alike. `organizationAvailable` alone can't say whether the
   organization gives a workspace anything besides its own account: sharing
   that account gives the workspace an organization copy of it too.
   `organizationAdministeredConnection` (organization context only, through
   the shared-workspace inventory) is the one condition every organization
   route uses, except the organization primary: it keeps the legacy rule
   (connections no workspace manages), failing closed. A former workspace
   account the organization later shares serves other workspaces through
   their organization-pool rows like any organization account, in spread or
   behind the primary, but cannot itself be made the organization primary;
   whether to allow that is an open question below.

#### Target shape for the SuperGrok and Claude cutovers

A legacy credential of either provider with `authority_scope = workspace` in
a shared workspace maps directly to the shape above, with nothing further to
run: a `shared` connection of the organization, `scope_kind = workspaces`
over that workspace, `allow_personal_workspaces = false`, one assignment
`(workspace)` and one assignment policy `(workspace, inference_pool =
workspace)` with the row's exact allocator, model allowlist and
`managed_by_workspace_id = workspace`, and the connection's
`managed_by_workspace_id = workspace` when its dedupe group has exactly that
one source (otherwise NULL, with one local policy per source, as 0689). No
auto-assignment row. Merged ids become aliases; the connecting person stays
audit metadata. The connection is then an organization account editable
through the provider-neutral access editor as soon as the provider's access
route reads the core. Personal-workspace and `user` credentials become
personal connections, outside the organization editor.

#### Finding

| Finding | Where | Fixed in |
| --- | --- | --- |
| A connection 0689 merged from two workspaces' copies of one upstream account gets `managed_by_workspace_id = NULL` with each copy's manager on its assignment policy, but no route or policy honours an assignment-level manager (the assignment-policy and designation policies require the connection-level manager), so those workspaces' administrators lost reconnect, allocation and model management of their copy. Restoring it grants management authority, which is an owner decision; this change does not alter it. The duplicated listing of such accounts on the Accounts page is fixed by the UI change. | 0642 policies, 0689 planner | open question |

Open questions for the product owner: whether sharing an account beyond its
managing workspace should end or narrow that workspace's delegated management
(decision 5); whether a workspace-managed account may be limited to chosen
people, and what then happens to the delegation (decision 5; refused until
decided); whether to restore per-workspace management of merged copies
(finding above); whether an organization administrator may designate a
workspace-managed account for Codex Apps in other workspaces it reaches
(decision 8); whether one may become the organization primary
(decision 10); whether narrowing a shared account back to its managing
workspace should keep the organization's "off" (today it removes the
organization's copies, so the switch is the connection's again until the next
share; keeping it needs a place only organization administrators write;
decision 5); and whether an organization save that keeps the model list should
leave the managing workspace's narrowed list alone (today it writes the saved
list to the connection and to that workspace's copy; keeping the manager's
list means leaving it on that copy only, while the organization save still
writes its list onto the connection, which the reach setter copies; the
workspace route would then report the list placement reads for its source, as
its switch does, and where that workspace also has an organization-pool row,
its automatic and organization sources would still serve the organization's
list; decision 5).

### 5.5 M5: settings with lockable overrides and the overview

Scope: SUB-SET-01, SUB-SET-02, SUB-SET-03 and the data of SUB-SET-05. The
screens (SUB-SET-04 and the SUB-SET-05 page) ship in a separate UI change,
previewed before merge. Cross-provider failover at run time is a later track;
this one stores and resolves its switch and fallback order.

**What exists.** The settings table, the NULL-inherits workspace rows, the
`locked_settings` column and the resolver that ignores a locked workspace
override all date from 0642/0644. Nothing wrote a lock, and nothing stopped a
workspace row from storing an override of a locked setting.

**Migration 0724 (rolling).** It changes no column, routine or value, so
every effective setting is the same before and after (asserted on staged
data with workspace overrides). It adds:

1. CHECKs: `locked_settings` names only the six keys; `fallback_order` maps
   each model to an array of model-id strings.
2. A `BEFORE INSERT OR UPDATE` guard on workspace rows. Setting or changing a
   locked setting is refused with 42501 and detail
   `subscription_setting_locked:<key>`; clearing it, or leaving it unchanged,
   is allowed. An upsert is judged on its proposed row, so `INSERT ... ON
   CONFLICT` (including `DO NOTHING`) carrying a locked value is refused even
   when it would change nothing. For map-valued settings the test is per entry: adding or
   changing an entry widens, removing one does not. The guard is SECURITY
   DEFINER so a caller who cannot see the organization row is not mistaken
   for an organization without locks; it reads that row through an owner-only
   `SELECT` policy scoped to the organization it names in a
   transaction-local setting (the table keeps FORCE RLS).
3. An `AFTER INSERT OR UPDATE OF locked_settings` trigger on the organization
   row (SECURITY INVOKER) that clears newly locked settings from the
   organization's workspace rows in the same transaction.
4. Serialization: the guard takes a shared transaction advisory lock on
   `subscription-settings-locks:<organization>`, the lock writer an exclusive
   one. A workspace write either commits before the clear or sees the lock.
   An upsert's guard takes the shared lock before it meets an existing row
   and waits for that row's lock, and a plain `UPDATE` locks its row before
   its guard asks for the shared lock. So the lock writer never waits while
   it could close a cycle: it only tries the exclusive lock, then locks the
   rows it clears with `NOWAIT`, and raises 55P03
   `subscription_settings_lock_busy` when either is taken. The repository
   takes the same advisory lock first, before any row lock: its workspace
   writers (the settings API and the core administration routes that write
   settings: primary, rotation and source; allocator, extra-credit and rename
   routes never take it) take it shared, and a lock change queues for it
   exclusively with a 3 s lock
   timeout. Widening writes that arrive after the change queue behind it, so
   a stream of writes cannot starve it, and none of the repository's writers
   holds a row while waiting for the lock. Holding the exclusive lock, the
   lock change locks no workspace row itself; only the trigger does, with
   `NOWAIT`. A writer outside the repository (the previous release during the
   rolling upgrade, which updates a row before its guard asks for the shared
   lock, or a raw or migration writer) can therefore make a lock change
   answer busy, never deadlock it. A lock change retries a busy answer or a
   40P01 for about 5 s (up to about 8 s in the worst case, with the lock
   timeout) and then answers 503 `settings_busy` (retryable, nothing
   written). Tested deterministically for both
   cycles (an upsert waiting on a row the lock writer holds, and a writer
   holding a row the lock writer would clear), for a lock change landing
   under four continuous upsert loops, and by racing the real
   personal-primary routine and raw upserts against lock changes.
5. A `BEFORE UPDATE OF account_id, workspace_id` trigger: a settings row never
   moves to another organization or workspace, and the organization row never
   becomes a workspace row or the reverse (42501
   `subscription_settings_identity_immutable`). Otherwise a moved row could
   carry a value past the guard, which compares a row with its old values.
6. Isolation: a workspace write that widens any setting, and a lock change,
   run only at READ COMMITTED (0A000
   `subscription_settings_requires_read_committed` otherwise), because an
   older snapshot could miss a concurrent lock or a concurrent workspace
   insert. Writes that only clear or keep values are allowed at any level.
   The settings repository and the core administration writers pin READ
   COMMITTED on their transactions whatever the connection default.

**API.** `GET/PATCH /v1/organizations/:organizationId/model-account-settings`
(organization owners and admins), `GET .../model-account-settings/overview`
(paged by workspace id, at most 500 per page), and
`GET/PATCH /v1/workspaces/:workspaceId/model-account-settings` (members read;
workspace administrators and organization administrators write). Writes take
an optional `expectedVersion` (409 on a concurrent change), refuse a lock with
409 `setting_locked` naming the settings, and deliver the core capacity wake
(`core_settings_changed`). An empty organization patch checks the version and
changes nothing (no new version, no wake). Every read goes through
`subscription_effective_settings`; nothing in the API resolves a value itself.
An organization with no settings row yet (the resolver returns NULL; the 0712
seed makes this rare) reads the seeded values at version 0, and its first
write accepts `expectedVersion: 0`.

**Sources.** Per setting: `locked` (the organization value applies and
workspaces cannot override it), `workspace` (this workspace overrides it; for
a map, at least one entry), or `organization`. Per-entry sources stay
available for maps.

**Core.** The core already reads effective settings for placement
(`readSubscriptionEffectiveSettings`); placement reads the effective fallback
order for a model through `fallbackOrderFor`. Turn placement still forces cross-provider
failover off with an empty fallback order (the M3 policy) until the failover
runtime ships.

Fail-closed choices (contract ambiguous; strictest option taken):

- A lock binds every writer: workspace administrators, organization
  administrators writing a workspace row, and the owner-run core routines
  (for example a workspace rotation, primary or source change through the
  provider routes, and a person's own primary in their Personal workspace).
  Every such refusal answers 409 `setting_locked` with the settings named,
  mapped once in the API error handler; the core's "not visible" handling of
  42501 excludes the guard's refusal.
- Locking clears existing workspace overrides of that setting; unlocking does
  not bring them back.
- A rotation lock also refuses setting or changing any workspace
  `*_primary_connection_id` column (found by name, so later provider columns
  are covered).
- `providers` is lockable, but changes only through the existing provider
  source routes.
- Rotation can be set only for providers registered on the shared core; any
  other provider is refused (422) because a value would have no effect.
- The settings API writes no overrides for Personal workspaces (409
  `personal_workspace`, `canEdit: false`); they follow the organization. A
  person's own primary may still set a rotation entry there (the existing
  personal-account route), and the workspace view then reports that entry's
  source as `workspace` with `canEdit: false`. A rotation lock binds Personal
  workspaces like any other: locking clears that entry, and choosing a
  personal primary is refused with 409 `setting_locked` while the lock holds.
  The overview lists shared workspaces only.
- Fallback order: at most 64 preferred models, 8 fallbacks each, model ids up
  to 200 characters, no repeats and no self-reference. The bound applies to
  the stored workspace override after a patch is merged, not only to the
  patch. Model ids are not
  checked against the catalog (placement skips unknown models).
- Personal fallback is never active for ownerless work (no session owner);
  this was already the eligibility rule and is unchanged.
- Writes that could miss a lock under an older snapshot are refused outside
  READ COMMITTED (item 6 above) rather than admitted as dormant overrides.

### 5.6 M5: explicit account choice and personal preferences

Scope: the explicit-choice half of SUB-SEL-02 and SUB-SEL-04, SUB-ELIG-05 and
SUB-OWN-05 for every provider on the shared core, and a person's own
personal-fallback opt-in (D-27). The model-picker screen ships in a separate
UI change, previewed before merge.

**What exists.** Connecting a personal account for any provider, including
API-key connectors, goes through `connect_subscription_core_personal`, which
already checks the effective `personalConnectionsAllowed`. The binding guard
(`guard_subscription_connection_reference`, 0642) already admits a personal
connection only for its owner, in their private session or Personal
workspace, while personal connections are allowed. Placement already applies
D-28 (the owner's personal account participates automatically in their
Personal workspace, after shared accounts) and D-12 (with fallback on, the
owner's personal account on the chosen model is tried before another model
or provider on a shared account). This change does not alter either order.

**What it adds.**

1. `readSubscriptionCoreSessionAccountChoice`: the picker read. It lists the
   workspace pool's shared accounts and the caller's own personal accounts
   (never another person's), each with whether it can be chosen for this
   session and why not (`inactive`, `personal_not_allowed`,
   `personal_not_owner_work`, and `session_has_no_owner` for an ownerless
   session, which may use only shared accounts through automatic
   selection), the session's per-provider bindings (the account is
   hidden when the caller may not see it), and the effective personal
   settings plus the caller's opt-in. It is provider-neutral and iterates the
   registered core providers, skipping a provider whose cutover is not
   enabled for the organization or that the workspace switched off (neither
   its shared nor its personal accounts are offered).
2. `chooseSubscriptionCoreSessionAccount`: one neutral entry point that sets
   an explicit choice for the selected connection's provider or returns the
   named provider (all providers when omitted) to automatic selection. It locks
   only the affected bindings, compares and swaps their versions (bounded retries against a
   concurrent placement; the whole transaction is replayed a bounded number
   of times when it loses a deadlock to a session's first placement, and
   then reports `conflict`), and leaves the decision to the binding guard: a
   refusal surfaces as `refused`, never as a silent fallback. The guard
   records the choosing subject as the binding's initiating
   subject, as the Codex pin does, so an API key or service may choose a
   shared account for a session it may see and never matches a personal
   account's owner. A turn waiting
   for capacity is woken and re-placed at once; otherwise the choice applies
   from the next turn. It records `model_account.selection.changed`.
   Saving a person's personal-fallback opt-in wakes that person's own
   waiting turns (sessions whose owner membership is theirs) of every
   enabled provider when the opt-in turns on, so a turn already waiting can
   fall back at once. No other session can place on their personal account,
   so no other turn is woken. Turning it off wakes nothing and moves no
   running turn (D-27).
3. Migration 0729 (rolling) lets a person read and change only their own
   `subscription_person_preferences` row (see `docs/deployment.md`). Its
   membership routine reads the caller's own membership through an
   owner-only, marker-gated SELECT policy, so it works under the documented
   migration owner without `BYPASSRLS`
   (`packages/db/test/subscription-person-preferences-owner-postgres.test.ts`).
4. API: `GET`/`PUT /v1/workspaces/{ws}/sessions/{id}/model-account` behind
   the session authorization middleware, and `GET`/`PATCH
   /v1/organizations/{org}/me/model-account-preferences` (same-origin
   browser writes; an agent needs full access). SDK methods match.

**Not in this change.** The existing provider pin routes (Codex, and the
SuperGrok and Claude pin translations their cutovers add) move onto the
neutral entry point after those cutovers merge, so the same routes are not
edited twice. Disconnect stays with each provider's writer until then.

### 5.7 M5: cross-provider failover

Scope: SUB-FAIL-01 to SUB-FAIL-09, SUB-FAIL-11 and SUB-WAIT-01 for chat
turns, with contract decisions D-33 to D-46, open questions Q-02, Q-04
and Q-06, and Q-05 resolved within implementation scope. Voice,
transcription and media never cross providers
(SUB-FAIL-10, §6.5). This section is the design only: every SUB-FAIL
requirement stays pending until the PRs in §5.7.9 verify it. Names refer to
the initial 2026-10-12 snapshot after the settings track (§5.5), with the
binding references reconciled after #4170 merged. Section 5.6 contains the
merged explicit account choice of #4168, which this design relies on.
Merged #4170 gives a session one binding per provider (migration 0733,
D-32); §5.7.1 describes it, and that prerequisite of the core step is met.
SuperGrok's chat placement and its media and quota reads are on main,
dormant (#4117, #4119); its settlement, waits and cutover and every Claude
step are still open PRs (§5.3), and where this design builds on them it
names them. Until those stacks merge, the first PRs of this plan add new
files and leave the files the stacks change alone, apart from one agreed
optional `adapter.ts` member and the migration lists (§5.7.9). B1 also
changes the mirrored request fence in `requests.ts`, after #4170 merges.

The behaviour: when every eligible account of the session's provider is
exhausted or unusable and the effective setting "cross-provider failover" is
on, the core moves the session to the next model in its fallback order whose
provider is on the core and has an eligible account with capacity. The
conversation continues from Opengeni's own durable history, never from
provider state. The session waits only when nothing it may use can serve it
anywhere, or when a pin or "only this model" forbids moving (SUB-WAIT-01).

#### 5.7.1 Placement today: one provider per turn

The worker places a chat turn through
`subscriptionCoreTurns(provider).placeSubscriptionCoreTurn`
(`packages/db/src/subscription-core/turns.ts`). `subscriptionCoreTurns` is a
`memoByProvider` factory, so each provider gets its own closure. The registry
in `packages/db/src/subscription-core-providers.ts` decides which providers
exist: `REGISTERED` holds only Codex on main, and `subscriptionCoreProvider`
throws for any other id. `placeSubscriptionCoreTurn` retries a lost
first-binding race (`SubscriptionBindingConflict`) three times
(`BINDING_CONFLICT_RETRIES`), then answers `lease_busy` with
`cause: "binding_conflict"`.

`placeOnce` is one transaction, opened by
`withSubscriptionCoreProviderPlacementWorld` with `lockBinding: true`
(`packages/db/src/subscription-core-placement-world.ts`):

1. `withSubscriptionCoreAcceptedTurn` sets the tenant and session RLS
   context and runs the exact accepted-turn gate
   (`assertSubscriptionCoreAcceptedTurn`). No row is locked.
2. The world reads the session and the turn without locks, including the
   provider's `sessionCompactionLock` SQL (Codex declares
   `session.codex_compaction_mode = 'remote_v2'` in
   `packages/db/src/subscription-core-codex-adapter.ts`). It authorizes the
   turn's frozen personal entry for this provider only
   (`authorize_subscription_personal_placement_access(..., providerId)`).
   Then it reads the effective settings
   (`readSubscriptionEffectiveSettings`), the session binding `FOR UPDATE`
   (`readSubscriptionSessionBinding` with `forUpdate`), and this provider's
   connections of its registered kind
   (`listSubscriptionConnectionsForPlacement`, a plain read).
3. `placeOnce` checks the cutover gate (`cutoverEnabled`) and the attempt
   fence (`readAttemptFence`), then narrows the world in
   `providerPlacementInput`. Settings are forced to
   `crossProviderFailover: false, fallbackOrder: {}`, connections are
   filtered to this provider, re-selection points come from
   `subscriptionCoreReselectionPoints`, and entitlement is mapped through the
   accepted policy's `upstreamModelId`. The world request from
   `placementWorldRequest` carries only the accepted model, with the comment
   "This provider only: no cross-provider failover on the core (M3 policy)".
4. Lease reuse: `readTurnLease` reads the turn's lease row and throws "A
   core turn lease belongs to another provider" when the row is not this
   provider's. A live lease of an older attempt answers `lease_busy`.
5. `decidePlacement`, or a sticky reuse of the attempt's own lease, decides.
   A wait returns the reason, `earliestResetAt` from the decision, and
   `healthRetryAt` from `earliestHealthRetryAt`, which reads this provider's
   connections of its kind only.
6. A run acquires the lease (`acquireSubscriptionTurnLease`, an upsert on
   `(workspace_id, turn_id)` in
   `packages/db/src/subscription-core-repository.ts`). The lease's `BEFORE`
   trigger `opengeni_private.guard_subscription_disconnect_admission` (0691,
   patched by 0697, 0699 and 0707) takes the per-connection advisory lock
   `subscription-refresh:<connection>`. Then `commitBinding` re-reads the
   binding `FOR UPDATE`, compares it with the row the decision used, and
   either advances the clock (`advanceSubscriptionBindingCacheClock`) or
   writes the binding through its compare-and-swap writer
   (`writeSubscriptionSessionBinding`). Ownerless sessions write no binding.

The lock order is the one in §4 and D-31: the binding row, then one
per-connection advisory lock (through the lease trigger), then the lease
row. Turn rows are locked only in shared modes. No transaction holds two
connection locks.

Per-provider bindings (#4170). Migration
`0733_subscription_session_bindings_per_provider.sql` changes the binding's
primary key to `(workspace_id, session_id, provider)`, and its trigger
`subscription_session_bindings_provider_fixed` refuses any provider change.
`readSubscriptionSessionBinding` then requires a `provider` and reads only
that row, `writeSubscriptionSessionBinding` upserts on the new key without
touching the provider, and `commitBinding` locks and writes only its own
provider's row. An explicit choice whose account was deleted waits as
`pinned_account_ineligible` (`DELETED_EXPLICIT_WAIT`, reported by
`providerPlacementInput`), and `commitBinding` refuses to write over it. For
a rolling window, a unique index on `(workspace_id, session_id)`
(`subscription_session_bindings_rolling_session_idx`) keeps the previous
binary's conflict target valid, so a session still holds at most one row.
The next drained provider cutover, whichever provider lands first, must
drop it after its preflight excludes every other runtime login and before
writing any binding of its own. Previous binaries must remain unable to
run after the drop. Retarget old upserts to the provider-keyed conflict
target first; keep the provider-fixed trigger enabled during a bulk move
or prove afterwards that no pre-existing row changed provider. These are
0733's requirements, not permission to deploy or cut over. #4170 and D-32
have now merged; this design's prerequisite is satisfied.

Waits. The worker arms the session's waiter with the decision's reason and
earliest reset (`armSubscriptionCoreCodexCapacityWait` in
`packages/db/src/index.ts`; the SuperGrok PR #4118 adds the generic
`armSubscriptionCoreCapacityWait`). `subscription_capacity_waiters` has one
row per session (primary key `(workspace_id, session_id)`) with a required
`provider`. Reconciliation (`reconcileSubscriptionCoreCodexCapacityWait`) is
handed an evaluation from `evaluateSubscriptionCorePlacement`, which builds
the same single-provider input without a lock or lease. A capacity wake
(`wakeSubscriptionCoreCapacityWaiters` in
`packages/db/src/subscription-core/waiters.ts`) matches only waiters of its
own provider and runs only while that provider's cutover is enabled.

The pure policy already models crossing. In
`packages/subscriptions/src/placement.ts`, `failoverCandidateModels` returns
the preferred model, then `fallbackOrderFor(settings, preferred)`; it skips
unknown models and, unless `crossProviderFailover` is on, models of other
providers, and it returns only the preferred model for "only this model" or
an explicit choice. `modelPermitted` applies the workspace ceiling, the
provider switch and the compaction lock (D-17, D-26). `decidePlacement`
tries each model on shared connections, then on the owner's personal
connections when personal fallback is active, before the next model (D-12).
It labels a later model of another provider `failover_cross_provider` and a
move back to the preferred model `return_to_preferred`, maps the reasoning
level with `mapReasoningLevel` (`packages/subscriptions/src/reasoning.ts`,
D-16), and computes the wait's earliest reset over every permitted model and
every connection in its input (D-22). The reference model
(`reference-model.ts`) checks the same crossing rule. What is missing is a
core path that gives the policy more than one provider.

#### 5.7.2 The failover step (D-33, D-34)

The step lives in two new provider-neutral modules:
`packages/db/src/subscription-core/failover.ts` (the router, the step and
its evaluation) and `packages/db/src/subscription-core/failover-world.ts`
(the world across providers). Both sit in a shared directory, so
`scripts/check-subscription-core-neutral.ts` forbids provider names and
provider-id conditionals in them. M4's per-provider routines are not edited,
and neither are `turns.ts` and `subscription-core-placement-world.ts`, which
the open M4 stacks still change. The step calls their exported functions
(`subscriptionCoreTurns(provider).placeSubscriptionCoreTurn`,
`subscriptionCoreReselectionPoints`, `withSubscriptionCoreAcceptedTurn`) and
the repository's (`readSubscriptionEffectiveSettings`,
`readSubscriptionSessionBinding`, `listSubscriptionConnectionsForPlacement`,
`writeSubscriptionSessionBinding`, `acquireSubscriptionTurnLease`,
`releaseSubscriptionTurnLease`). Two reads it needs are private functions
of `turns.ts`, `readAttemptFence` and `readLastContextReplacedAt`, and so is
`commitBinding`, whose rules the step's own commit follows. The step carries
provider-neutral copies with the same SQL and rules, conformance cases run
the same fenced, compacted and commit scenarios through both paths, and a
hook after the M4 stacks makes `turns.ts` use the copies (§5.7.9).

**When it runs.** A turn's home provider is the provider of its accepted
model, and its home row is the session's binding for that provider. Model
failover is allowed for a turn when all of these hold: the deployment
setting is on (D-43); the home provider is on the core (D-34); the home row
is neither explicit nor "only this model" (D-46); the accepted policy has no
credential restriction; and the work is a chat turn. Its candidates are those of
`failoverCandidateModels`: same-provider entries of the fallback order
always, and models of other providers only when the effective
`crossProviderFailover` is on. Core placement ignores same-provider model
entries today (`fallbackOrder: {}`), so the same step also serves them. When
failover is not allowed, or there is no candidate besides the preferred
model, placement is exactly M4's `placeSubscriptionCoreTurn`, as today.

A provider-neutral entry, `placeSubscriptionCoreTurnWithFailover`, routes:

- When failover is allowed and the session is serving a fallback for this
  turn's accepted model (the continuity read, "What the next turn does"
  below), or the turn's lease row is on another provider, the step runs
  directly. M4's routine reads only the home row, so it would bring the
  session home while the fallback's cache is warm, and its `readTurnLease`
  refuses a lease row of another provider ("A core turn lease belongs to
  another provider").
- Otherwise M4's routine runs first. Before it, a turn lease row of another
  provider, which only an earlier failover leaves, is settled by M4's own
  lease rules: an older attempt's live lease answers `lease_busy`, and this
  attempt's own or an expired one is released. M4's `run`, `lease_busy`,
  `attempt_fenced`, `not_visible` and `cutover_not_enabled` results are
  returned unchanged. When failover is allowed, a wait with reason
  `no_eligible_capacity`, `model_not_allowed` or
  `compaction_provider_locked` hands over to the step.
  `pinned_account_unavailable`, `pinned_account_ineligible` (including
  #4170's wait on a deleted pin) and `accepted_authority_unavailable` never
  move.

When failover stops being allowed for a session on a fallback (the
deployment setting was turned off, or a person pinned a home account or set
"only this model"), M4's routine places the turn from the home row, which no
failover changed. The fallback provider's row stays as stored and goes
cold. When only the candidates change (the organization turned
cross-provider failover off, or a workspace now restricts the fallback
model), the step still runs and re-selects away from the fallback as a
forced reason (`bindingStickiness`, D-31).

The step is a second transaction and a full decision, not a patch on the
first. It evaluates the preferred model again, so capacity that returned in
between still wins.

**The transaction.** The step runs one transaction per attempt:

1. `withSubscriptionCoreAcceptedTurn` opens the same exact-turn gate.
2. A new `withSubscriptionCoreFailoverPlacementWorld` (`failover-world.ts`)
   reads the session, the turn and the effective settings without locks. It
   evaluates every registered provider's `sessionCompactionLock` in that
   read, and it reads which model the session is serving (the continuity
   read, below).
3. It builds the candidate models (§5.7.3). Each resolves to a provider
   through both the code registry (`REGISTERED` in
   `subscription-core-providers.ts`) and the database registry
   (`opengeni_private.subscription_core_providers`, 0707). A provider
   missing from either registry, or whose route
   for the organization is not `core` (`readSubscriptionCoreProviderRoute`),
   is dropped with its models (D-34). The home provider must be `core` as
   well, or the step returns M4's wait unchanged. Crossing also requires a
   successful catalog check proving there is no unique index on
   `subscription_session_bindings` whose key attributes are exactly
   `{workspace_id, session_id}`, regardless of their order or the index
   name. Resolve the scoped relation and attributes through `pg_class`,
   `pg_namespace` and `pg_attribute`, then inspect `pg_index.indisunique`
   and the first `indnkeyatts` entries of `indkey`; INCLUDE attributes are
   not keys. Conservatively treat partial or invalid matching indexes as
   blockers too. A missing relation, failed read or unrecognized catalog
   shape disables crossing, never proves removal. While such an index
   exists, every non-home provider is dropped. A session may hold only one
   row under 0733's rolling index, so the step could not record a fallback
   beside the home row or later bring the session home (D-46). Renaming the
   index does not change this decision.
4. For each candidate provider that the turn's accepted authority has a
   frozen personal entry for, it authorizes that entry
   (`authorize_subscription_personal_placement_access(..., provider)`),
   before the binding lock as M4 does.
5. It locks the binding rows of the home provider and of every remaining
   candidate provider, `FOR UPDATE` and in provider-id order, through
   `readSubscriptionSessionBinding` with `provider` and `forUpdate`, before
   any connection lock. A row that does not exist yet is not locked; its
   first insert is guarded by the primary key, and a lost race retries
   through `SubscriptionBindingConflict` as in M4. If the home row is now
   explicit or "only this model", the step places nothing and the router
   runs M4's routine, which keeps or waits for the pin. The step then reads
   each candidate provider's connections of its registered kind with
   `listSubscriptionConnectionsForPlacement` (plain reads, no locks).
   Entitlement is mapped per candidate model through that model's upstream
   id, as `providerPlacementInput` does for the accepted model.
6. It merges everything into one `PlacementInput`: every candidate model
   with its reasoning ladder and tier, the union of connections,
   `cacheFacts` and `quotaStaleAfterMs` per provider, and the real effective
   settings. The session's binding is the row of the provider it is serving
   on: the fallback provider's row when the continuity read names a
   fallback, else the home row. An explicit fallback row is passed as
   automatic, because its pin is applied as a filter instead. `onlyThisModel`
   is the home row's, which is off whenever the step runs. Re-selection
   points come from `subscriptionCoreReselectionPoints`, given that row and
   the model the session is serving (D-36). Every candidate provider's row
   other than the home row, the fallback row included, filters the input
   (D-46): an explicit row keeps only its pinned connection among its
   provider's connections, a row with "only this model" keeps only its own
   model among its provider's models, and an explicit row whose account was
   deleted removes its provider.
7. It checks the attempt fence (its copy of `readAttemptFence`) and applies
   M4's lease-reuse rules to the turn's lease row, whatever its provider.
8. One `decidePlacement` call decides. On a run it releases a reused lease
   that is not the chosen connection (`releaseSubscriptionTurnLease` deletes
   the row for its provider), acquires the lease for the chosen connection
   and its provider, and commits the binding of the chosen provider only,
   by that provider's own rules ("The binding rows", below). On a wait it
   returns the reason, the earliest reset and the earliest health retry
   across the candidate providers.

**No lock-order cycles.** Placements, pins and request reservations take the
binding rows they lock before any connection lock. M4's placement, a
person's pin and a request's reservation each lock one row, of their own
provider (#4170), then at most one connection. The step locks several rows
of one session, always in provider-id order, then acquires one lease;
reading other providers' connections takes no row or advisory lock. So no
transaction holds two connection locks, and no two transactions lock one
session's rows in opposite orders. A row's first insert comes after the
lease, as M4's first binding does, but the binding's admission trigger
(`zz_subscription_binding_disconnect_admission`, 0691) takes an inserter's
connection lock before its row exists. That insert can therefore wait only
for another first insert of the same row, which waits for nothing after
inserting, and the loser retries. Because the connection reads are
unlocked, the decision can be stale when the lease is taken. That is
already true of M4 placement, and it is corrected the same way: the lease
trigger re-checks the connection's admission under its lock, and a provider
refusal settles and re-places. PR B1's concurrency test
(§5.7.9) races two sessions crossing in opposite directions with a pin of
one target, a credential refresh of the other, a disconnect and a model
request reservation on the same turn. Releasing
the old provider's lease takes no connection lock: the admission trigger
fires only on insert and update (`zz_subscription_lease_disconnect_admission`,
0691), and the binding's own admission trigger takes the same connection's
lock the new lease already holds.

Serving-revision, pending-target and switched-event writes stay outside
this placement transaction. `lockTurnAttemptWriteFenceTx`
(`packages/db/src/session-attempt-fence.ts`) calls
`lockSessionEventWriteRows`, which takes the turn `FOR UPDATE`.
`reserveTurnRequest` (`subscription-core/requests.ts`) takes the turn
`FOR SHARE`, then the binding `FOR UPDATE`, then the connection lock.
Taking the write fence while holding bindings would invert that order and
deadlock with a reservation. The selection hook writes in a separate
fenced transaction only after placement commits and releases all binding
locks. Claim-time revision recording also has no placement locks. B1 and
C2 test this ordering. Candidate binding locks briefly delay pins for that
session until the step commits; no other session's bindings are held.

**The binding rows.** Each provider has its own row (#4170, D-32), and the
step writes only the row of the provider it places on: the target, or the
home provider when the session returns. It never writes the source
provider's row or any other provider's, and never changes a row's provider
(0733's trigger refuses it). The write follows the rules `commitBinding`
applies to its own provider's row, through a provider-neutral copy in
`failover.ts` that PR H later shares with `turns.ts`. The step compares the
row with the copy it locked, refuses to write over an explicit choice whose
account was deleted, advances the clock
(`advanceSubscriptionBindingCacheClock`) when the connection and model are
unchanged, and otherwise writes through `writeSubscriptionSessionBinding`.

A new row gets the connection, the model, the choice automatic, "only this
model" off, `last_switch_reason` `failover_cross_provider` or
`return_to_preferred` (migration 0642 already allows both) and the placement
time as its clock. An existing row keeps its choice and "only this model",
as `commitBinding` keeps them, and takes the new connection, model, reason
and clock. An explicit row is only ever placed on its pinned account, so its
pin is unchanged. Migration 0723's trigger
`subscription_session_bindings_cache_clock` clears `last_model_call_at`
when the connection, model or choice changes without a stated clock; the
step always states one. Each provider's row keeps its own clock, so warmth
never carries from one provider to another (D-31). Ownerless sessions write
no binding, as in M4.

**What the next turn does.** Failover never changes the session's model, so
the next turn accepts the preferred model again and has the same home
provider. Whether the session is serving a fallback comes from the serving
revisions of §5.7.4 (D-37): this turn's latest revision, or else the latest
revision of the session's previous claimed turn (the latest earlier turn by
`session_turns.position` whose metadata has `turnExecutionPolicyV1`) when
that turn accepted the same model. A revision naming another model means the
session is on that fallback, and the fallback's account and clock are in
that provider's own row. No session-level record is added, so this does not
depend on 0733's rolling index, which lets a session hold only one row.

On a fallback the step keeps the fallback while its account can serve and
its cache is warm. Once the fallback is cold, it returns to the preferred
model if that model can serve (`return_to_preferred`, writing the home row),
and otherwise moves on down the order. A person who changes the session's
model ends the fallback, because the accepted model no longer matches. One
who pins a home account or sets "only this model" ends it too, because
failover is no longer allowed. A turn that records no revision, for example
one that fails before it is placed, leaves its successor at home, an error
toward the preferred model. Ownerless sessions have no rows, so a fallback
is never warm for them and the preferred model is tried first.

**Target not on the core.** Strictest choice (D-34): only providers on the
core are targets. A fallback model of a provider absent from either the
code or database registry, or
whose route for the organization is `legacy` or `maintenance`
(`readSubscriptionCoreProviderRoute` in
`packages/db/src/subscription-core/provider-route.ts`), is skipped as if
unknown. The step never calls a legacy runtime, never counts that provider's
accounts as capacity and never reports its resets. A session whose home
provider is not on the core does not move at all. #4117 keeps SuperGrok out
of the registry until its cutover, so until the SuperGrok and Claude
cutovers land (#4104, #4137), Codex sessions have no production target; the
shared test provider and the fake API-key connector exercise the step.

The route is stricter than M4's own gate. `cutoverEnabled` in `turns.ts`
reads only the organization's switch row, and migration 0712 notes that a
deployment can still hold switch rows and core connection rows written
before its receipt policies, for a provider without a receipt. The route
also requires the receipt (`subscription_provider_cutover_committed`), so
such a provider stays `legacy` and is never a target. The database backs
this up. Since 0712, a core connection row and an enabled switch row need
the receipt (`subscription_connections_receipt_insert`,
`subscription_provider_cutovers_receipt_update`), and a lease must name a
core connection of its own provider (the
`(account_id, provider, connection_id)` foreign key of
`subscription_leases`, 0642). A drained cutover inserts the receipt and the
registry row before it moves rows, in its migration transaction (#4104's
cutover migration, 0718 on its branch, whose stage in `cutover-stage.ts`
takes that transaction), so a concurrent step sees either none of it, and
skips the provider, or all of it. After the cutover, an operator hold
(`maintenance`) is read in the step's transaction exactly as M4 reads its own
gate. A real-PostgreSQL test in PR B1 covers each case (§5.7.9).

**The wait.** `decidePlacement`'s final wait already takes the minimum
`servableAgainAt` over every permitted candidate model and every connection
the session may use automatically. With all candidates in one input, the
reported reset is the earliest across providers (D-22). The health retry is
the minimum of each candidate provider's quarantine and catalog deadlines
(`earliestHealthRetryAtAcrossProviders`). It inherits the limit noted under
PR 0b part 3: the lookup reads as the application role, so a quarantined
personal account falls back to the waiter's backoff. The waiter row keeps
the home provider and records its candidate providers (D-41). A
wake of any candidate provider wakes it, and reconciliation is handed the
step's evaluation (`evaluateSubscriptionCorePlacementWithFailover`, no lock
or lease) instead of the single-provider one. The wake and arm changes edit
`waiters.ts` and the worker's waits, so they wait for the M4 stacks
(§5.7.9).

Candidate providers are wake hints, not frozen eligibility. On every arm
and reconciliation, recompute the entire candidate set from current
settings, model permissions, pool eligibility and cutover routes, while
preserving the accepted authority. Update both the waiter read and UPDATE
predicates to match the home provider or `candidate_providers`; add a GIN
index for the array containment query. Arming uses the failover-aware
evaluation, not the home-only decision.

Later changes must not strand an armed waiter (D-41, SUB-WAIT-01/02).
Today the settings route's `wake` (`apps/api/src/routes/model-account-settings.ts`)
sends a best-effort Codex wake; route reads and cutover commits themselves
do not wake waiters. Preserve existing mutation wakes, and explicitly use
a bounded reconciliation for changes outside the recorded candidates or a
lost wake. For failover-aware waits, B2 caps `nextCheckAt` at the existing
`codexCapacityRefreshBackoffMs` deadline (at most 15 minutes), even when
`earliestResetAt` is known; `subscriptionCoreCodexNextCheckAt` in
`packages/db/src/index.ts` currently returns a known reset without that
cap. Keep the true earliest reset in the reported wait, separately from
the check deadline. Thus enabling failover, allowing a model, changing a
pool or completing a cutover refreshes eligibility by the next bounded
check without making a provider call or widening background authority.

#### 5.7.3 Model mapping (D-35)

The contract's fallback order is per preferred model: an explicit list of
model ids in the effective settings, possibly on other providers
(`fallbackOrderFor`, resolved entry by entry, D-25). The owner's brief
speaks of an adapter-declared equivalence or tier. One rule covers both:

1. An explicit effective entry for the preferred model wins, including an
   explicit empty list, which means "no fallback model" (the settings
   contract and `fallbackOrderProblem` accept an empty list).
   `failoverCandidateModels` keeps reading the list through
   `fallbackOrderFor`, as #4122 intends. That helper returns `[]` for both a
   missing and an empty entry, so a sibling
   `hasFallbackOrderEntry(settings, preferred)` in
   `packages/subscriptions/src/settings.ts` tells them apart, and nothing
   indexes the map directly.
2. With no entry, and only when cross-provider failover is on, a default
   order is derived from adapter-declared tiers: the models of other core
   providers that declare the preferred model's tier, never a lower or a
   higher one. Providers come in registry order
   (`subscriptionCoreProviderIds`, sorted by id) and models in each
   adapter's declaration order, at most
   `FALLBACK_ORDER_LIMITS.fallbacksPerModel` (8) models. A preferred model
   without a declared tier derives nothing, and a model without one is never
   derived. Same-provider model fallback stays explicit only.
3. Entries naming unknown models, or models of providers not on the core,
   are skipped (D-34), as §5.5 already says for unknown models.
4. Workspace restrictions, provider switches and the compaction lock then
   filter the candidates (`modelPermitted`, D-17, D-26), and the reasoning
   level maps by D-16 (`mapReasoningLevel`).

Staying on the same tier is the strictest reading of "equivalent": a higher
tier spends subscription capacity faster, and a lower one quietly lowers
quality. An administrator who wants either lists it explicitly, and so does
one who wants another provider order. Whether the derived order should also
step down to lower tiers is open (Q-04).

**The adapter capability.** One optional member, the purely additive change
the M4 owners agreed to, so no adapter needs an edit:

- `ModelTier` (`packages/subscriptions/src/types.ts`): a closed set of tier
  names declared once in the pure package (for example
  `"frontier" | "standard" | "fast"`). It names no provider. Equality is the
  only comparison D-35 needs; an order is added only if the owner allows
  stepping down (Q-04).
- `SubscriptionCoreAdapter.modelTier?(modelId: ModelId): ModelTier | null`
  (`packages/subscriptions/src/adapter.ts`), optional like `fetchUsage`,
  `decodeQuota` and `liveModels`. An adapter without it, and a model it does
  not declare, has no tier, so nothing is derived for it or to it and only
  explicit entries apply. Each provider's adapter module, outside the shared
  directories, adds its declarations after that provider's M4 stack merges
  (§5.7.9).

No history capability is added. The `historyCompatibility()` member in
`adapter.ts` belongs to `ModelConnectionAdapter` (§2.1), which no core
adapter implements, and `SubscriptionCoreAdapter` has none. The request copy
decides instead from where each history row came from, with the runtime's
provider-neutral test for opaque artifacts (§5.7.4). This refines the
request-copy note in §4.

`ModelDescriptor` (`types.ts`) gains an optional `tier`, so the descriptors
M4's placement builds compile unchanged. The worker builds the candidate
catalog from the
deployment's model configuration and each adapter's declarations, and
passes it in the placement request. The policy picks from it with the
settings it reads inside the transaction. Shared code compares tiers and
treats `model.provider` as an opaque key, so it never names a provider, and
the neutrality guard keeps it that way.

#### 5.7.4 Worker: switching provider and model (D-36 to D-39, D-45)

**How a turn's provider and model are chosen today.** At claim
(`apps/worker/src/activities/agent-turn/claim.ts`), the turn's
`TurnExecutionPolicyV1` (`packages/contracts/src/index.ts`, metadata key
`turnExecutionPolicyV1`) is installed once by
`installOrReadTurnExecutionPolicyForAttempt` and kept for every attempt of
the turn. `settingsForAcceptedSubscriptionTurn` and
`assertTurnExecutionPolicyMatchesConfigV1` (`packages/config/src/index.ts`)
require its product model and reasoning to equal the accepted turn's
(`turn.model`, `turn.reasoningEffort`). `runtime.configure` builds the
clients, `billingState.isCodexTurn`, `isXaiTurn` and `isClaudeTurn` come
from the policy, and `assertSessionAllowsProductModel` enforces the
compaction lock. `run.ts` then calls `selectCodexTurnCapacity`,
`selectXaiTurnCapacityByRoute` and `selectClaudeTurnCapacity` in turn; their
core paths run the generic `selectCoreSubscriptionTurnCapacity` with a
per-provider `CoreTurnPlacementProvider` (`subscription-core-capacity.ts`).
The provider is fixed for the whole turn.

**Serving revision.** The accepted policy stays immutable: it is what the
turn accepted, and admission SQL reads it (for example the credential
restriction in 0608 and the binding backfill in 0689). A placement on
another model records a serving revision instead: a new turn metadata key,
`turnServingPolicyV1`, holding a list of revisions. Each is a full policy
for the serving model (provider id, upstream model id, wire API, credential
source, billing and definition version) with the mapped reasoning level, the
execution generation, the selected connection (advisory until placement),
the reason, and the session's highest history position when it was
recorded. A new fenced database
function, `recordSubscriptionCoreServingPolicyForTurnAttempt`, writes it
under the attempt fence. It is idempotent per scoped `(turn, execution
generation)`: a replay returns the existing revision and its original
high-water position, and a different
policy for that key is a conflict, never an overwrite or another revision.
Record once at claim, before runtime configuration, with the current
history high-water position. A failover-enabled turn records an initial
baseline even when it starts on its accepted model. A turn with a
credential restriction never gets one.

A later placement or mid-turn evaluation cannot rewrite that generation's
policy. It stages a separate pending recovery target, keyed by the source
generation, with the recovery request. C2 extends `requestSessionTurnRecovery`
to validate and store that target atomically with the existing recovery
transition, using its turn write fence, after placement commits. A repeated
identical request is idempotent; a conflicting target is refused. At the
next successful claim, the revision writer consumes that pending target
and records the newly claimed generation's policy in one transaction.
Pending targets are not serving revisions, history provenance or switches;
abandoned proposals never affect those. A claim without a pending target
keeps this turn's latest committed revision, if one exists. This separates
one policy per generation from a proposal to configure the next generation.

**Between turns.** A new turn's accepted model is the session's preferred
model, so every turn served by a fallback model has a serving revision,
whether it newly crossed or stayed on a warm fallback. A provider or model
change takes effect only at the start of an attempt, because the runtime,
tools, billing flags and history projection are all built at claim:

- At the first claim of a new turn, when failover is allowed and the session
  is serving a fallback
  (the continuity read of §5.7.2), the worker asks the step's evaluation (no
  lock or lease) where the turn would run. Here "another model" means
  another than this turn's accepted model, not the prior turn's revision.
  It records the selected model as this turn's baseline before configuring
  the runtime. Later claims consume a pending target or retain this turn's
  latest revision; they do not repeat the first-claim continuity decision.
- The attempt configures everything from the latest revision. It validates
  the revision against the configuration for the serving model and mapped
  level (the checks of `assertTurnExecutionPolicyMatchesConfigV1`, through a
  serving variant), sets the billing flags from it, re-runs the funding
  check (`ensureRunAllowed` with the serving billing identity), and checks
  `assertSessionAllowsProductModel` with the serving model.
- Placement in the same attempt stays authoritative. If it chooses a
  provider or model other than the one the attempt is configured for, the
  attempt releases its lease and stages the pending target with recovery
  (`requestSessionTurnRecovery`; its reason is free text, so a new reason
  needs no migration). The fresh attempt starts on the new model.

A fallback never moves a subscription turn onto Opengeni credits, because
only core providers are targets (D-34).

**Mid-turn (SUB-FAIL-08).** Exhaustion during a turn already settles through
a fenced failover. `failOverCoreCodexTurn`
(`apps/worker/src/activities/agent-turn/codex-core-failover.ts`, generalized
by #4118 as `failOverCoreSubscriptionTurn`) makes the history durable
(`historySink.reconcileConversationTruth({ requireDurable: true })`),
checkpoints the request ledger (`core.requests.checkpoint()`), gives up when
a request outcome is unresolved (`canRecover()`), counts refusals, releases
the lease and requests recovery. Cross-provider failover reuses that
boundary, so a switch happens between model calls, never inside one. (Between
calls the placed core is already revalidated: `revalidatePlacedSubscriptionCore`
in `subscription-core-placed.ts` checkpoints the request ledger and re-checks
the source connection.) Before
requesting recovery, the settlement asks the step's evaluation where the
turn would run and, when that differs from this generation's serving
provider or model, stages the pending target with the recovery request,
so the next attempt records its own revision and starts on the
target instead of restarting twice. The next attempt's placement stays
authoritative, within the bound below.

What a switch keeps and drops:

- Completed tool calls stay in canonical history and are not repeated;
  image and video operations key their idempotency on the turn and call
  (§4). Usage and accounting entries of completed calls are kept. Usage is
  recorded per call with its own route, so calls after the switch are
  attributed to the serving model (SUB-ACCT-02).
- The request copy, never canonical history, drops provider-specific items.
  `apps/worker/src/activities/run-input.ts` builds the model input with
  `projectRejectedProviderArtifacts` and then
  `projectHistoryForProvider(canonicalView, providerApi)`
  (`packages/runtime/src/provider-history-adapter.ts`), which already
  projects history for another wire API when a person changes the session's
  model. Two providers can share a wire API and still reject each other's
  opaque artifacts; the comment on
  `omitOpaqueArtifactsFromPortableCompactionHistory` cites
  `invalid_encrypted_content`. So the request copy also drops opaque
  artifacts from every row another provider produced. History rows carry no
  provider, but each carries its `turn_id`: the row's provider is that of
  the turn's latest serving revision recorded below the row's position, or
  else of the turn's accepted policy. Opaque means what the runtime's
  provider-neutral `hasOpaqueProviderArtifact` detects (reasoning or
  compaction items with `encrypted_content`). Those items are projected as
  the reactive path projects them (`projectRejectedReasoningArtifact`, and
  compaction items left out). Rows the serving provider produced keep their
  artifacts. Rows without a turn or a readable policy keep today's
  projection, and the reactive invalidation
  (`provider_artifact_invalidated_*` markers) stays as the backstop. This
  needs no binding column, so it also covers ownerless sessions, which
  write no binding.
- Unknown outcomes block the switch (D-38). The admission trigger refuses a
  new model request while an earlier model request of the same turn is
  `unknown`, or `reserved` by another attempt (0691), but it compares only
  requests of the same provider (`prior.provider = NEW.provider` in 0707's
  patch of `guard_subscription_disconnect_admission`), so an unknown request
  on one provider does not fence a request on another. Dropping that
  prior-provider predicate alone is insufficient. Migration 0699 also
  exempts earlier-generation attempts closed as `failed`,
  `interrupted_recoverable` or `lease_lost_recoverable`, and 0707 preserves
  it. `requestSessionTurnRecovery` closes the source attempt as
  `interrupted_recoverable`; `claimSessionWorkForAttempt` then advances the
  generation. B1 narrows that exemption to prior requests of the SAME
  provider as the new request, in both the trigger and its mirrored query
  in `reserveTurnRequest`. Remove the outer provider filter in both queries,
  and add `prior.provider = NEW.provider` (or the corresponding request
  alias and `providerId`) INSIDE the closed-attempt exemption. An unresolved
  request from another provider then remains blocking after recovery and
  reclaim, even if that provider is no longer registered. Same-provider
  recovery semantics are unchanged. The database is authoritative; the
  worker's checks of all ledgers are an additional early guard. Tests drive
  the actual recovery/reclaim path and verify both the typed refusal and
  direct SQL admission, not just open same-generation attempts.

**Return to the preferred model (SUB-FAIL-07).** The pure policy already
does this: `bindingStickiness` keeps a fallback binding while its account
can serve it and its cache is warm, and once the cache is cold
`decidePlacement` tries the preferred model first and labels the move
`return_to_preferred`. The step gives it the right binding without editing
`turns.ts`: the fallback provider's row, and as the turn's model for
`subscriptionCoreReselectionPoints` the model the session serves there. So
`model_changed`, which that function adds whenever the bound model differs
from the turn's model, does not fire for serving the fallback (D-36). A
person's change of the session's model ends the fallback through the
continuity read instead. M4's routine reads only the home row and would
bring the session home at once, so the router never hands it a session on a
fallback while failover is allowed; when failover is no longer allowed,
returning home at once is the intended behaviour. Same-provider model
fallback works the same way, with the home row as its fallback row. A
return happens only at placement, and a later attempt of the same turn
keeps its serving model unless its account is forced away, so a turn never
bounces back while the fallback can serve it.

**Per-turn bound (SUB-FAIL-11).** `countSubscriptionCoreTurnRefusals` sums
the turn's `subscription_turn_failures` for one provider, and the limit is
`SUBSCRIPTION_CORE_CODEX_TURN_REFUSAL_LIMIT = 4` (#4118 renames it
`SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT`). A per-provider count would allow
four refusals on every provider. The bound becomes one count across all
providers of the turn (`countSubscriptionCoreTurnRefusalsAcrossProviders`).
Read `subscription_turn_failures` directly under the accepted-turn gate,
using the existing `recovery_evidence.refusals` aggregation but no provider
or switch filter. Do not sum calls to the per-provider helper: it returns
null when that provider is held, which must not erase prior refusals.

Add one only for a committed revision whose serving provider or model
differs from the preceding committed revision of THIS turn. The first
revision is the baseline and contributes zero, including a warm fallback
inherited at first claim. Identical policies in later generations, retried
recordings, pending targets, account-only moves and bookkeeping contribute
zero. The writer's `(turn, generation)` idempotency prevents retries from
using budget. Before committing a transition, check the prospective total
under the turn fence; reject one that would exceed 4. At a total of 4,
permit no further failover recovery. Capacity flapping therefore cannot
restart a turn indefinitely (D-39). Refusals stay recorded per connection.
At the bound the turn stops
with the existing exhausted-failover failure
(`subscriptionCoreFailoverExhaustedFailure`).

**Visible event and indicator (SUB-FAIL-06).** Every placement that changes
the account or model records `subscription.account.switched { provider,
fromConnectionId, toConnectionId, fromModel, toModel, reason }` (§6.2)
through the selection hook of the generic capacity path
(`CoreTurnPlacementProvider.recordSelection`). It runs in a separate fenced
transaction AFTER placement commits, never while binding locks are held.
It refers to that generation's immutable serving revision; where recording
both together is appropriate, the same separate fenced transaction may do
so idempotently. A placement that instead requires recovery records only a
pending target: emit the switch once the fresh attempt is configured and
placed on that target, not for an unserved proposal. Retried selection
recordings deduplicate the same generation and selection transition.
`codex.account.switched`, written today by
`recordSubscriptionCoreCodexSelectionForTurnAttempt`, stays as the alias
for Codex-to-Codex switches (SUB-COMPAT-02). The runtime PRs keep what the
web shows unchanged: `attempt.modelRoutePresentation` keeps the accepted
model, and if the timeline would render an unknown event type, the event
waits for the UI change. PR F (§5.7.9) shows the serving model in the
session indicator and a notice of the switch, previewed with real
components and approved by the owner before merge (D-08, D-45).

#### 5.7.5 Codex remote-compaction sessions (D-40, Q-05 resolved in scope)

**What remote compaction keeps.** `compactContextRemoteV2`
(`apps/worker/src/activities/context-compaction.ts`) asks Codex for a
compaction item and installs `buildRemoteV2ReplacementHistory`
(`packages/runtime/src/context-compaction.ts`): the latest skill catalog,
the newest user, system and developer messages within
`REMOTE_V2_RETAINED_MESSAGE_TOKEN_BUDGET` (64 000 tokens), the attachment
catalog, the opaque `{ type: "compaction", encrypted_content }` item (with
a `summary` only when Codex returns one) and the reasoning configuration.
Its event's `implementation` is `responses_compaction_v2`. Assistant
messages, tool calls and tool outputs survive in that replacement only
inside the opaque item, which only Codex can read. This does not describe
Opengeni's inactive durable rows; D-40 corrects D-19's earlier premise.

**What Opengeni keeps.** `applyContextCompaction`
(`packages/db/src/index.ts`) runs under the attempt fence
(`lockTurnAttemptWriteFenceTx`). It sets every active
`session_history_items` row inactive and inserts the replacement rows as new
rows after every existing row (`supersededFrom` is the old maximum position
plus one), then the summary at `summaryPosition` and any trailing rows. It
never deletes: the schema comment says the full transcript stays as an audit
trail, and `clearSessionContext` does the same with one boundary marker.
Rows are deleted only by an archive purge, and an archived session runs no
turns. The `session.context.compacted` event records `summaryPosition`, and
`session_events` keeps the timeline. In the worker, `historyRowsToAppend`
(`history.ts`) appends to the active view, `HistoryPrefixGuard`
(`history-prefix.ts`) refuses a changed durable prefix, and
`TurnHistorySink.reconcileConversationTruth` (`history-sink.ts`) makes a
turn's items durable before a failover. So every row a remote compaction
summarized is still stored in cleartext, except opaque artifacts (the
compaction item and encrypted reasoning).

**The conversion.** A safe conversion exists, so the design uses it:

1. The pure policy treats a remote-compaction lock as convertible when
   cross-provider failover is allowed and the session has no recorded
   conversion refusal: a model of another provider is permitted, and the
   run result carries `convertsCompaction`. Without that, the lock keeps
   restricting models as today (D-26).
2. The serving revision records the conversion. The fresh attempt on the
   target runs it in `compaction-prep.ts` before its first ordinary model
   call. The gates that lock a remote-compaction session to Codex accept a
   non-Codex model only for an attempt whose serving revision carries the
   conversion, and only until it completes:
   `assertSessionAllowsProductModel` (`packages/core/src/domain/sessions.ts`),
   the "requires a Codex model" check in
   `packages/core/src/goal-admission.ts`, the fail-closed throw in
   `maybeCompactContext`, and the `remote_v2` branches of
   `compaction-prep.ts`.
3. The rebuild reads the session's own rows since its latest context-clear
   marker, in position order. It leaves out every row a compaction
   installed (each `session.context.compacted` event's block: its
   replacement rows, its summary at `summaryPosition` and its trailing rows)
   and every opaque artifact
   (`omitOpaqueArtifactsFromPortableCompactionHistory`). What remains is the
   conversation as it was written, in cleartext. New compactions record
   `supersededFrom` and the block's length in the event payload. For
   existing events, attribute the summary by `summaryPosition` and the
   compaction turn id; all replacement rows from that transaction share its
   `created_at`, while replacement and trailing rows have NULL `turn_id`
   (`applyContextCompaction`). Do not assume every historical block starts
   after the earlier maximum: the older layout documented in `schema.ts`
   used a fractional summary position ahead of retained history. The first
   implementation refuses fractional or unsupported layouts. For supported
   layouts require one unambiguous contiguous block, matching transaction
   timestamp and turn attribution, with no competing compaction event or
   unrelated rows. Timestamp equality alone is not proof. Refuse any block
   that cannot satisfy those checks; never guess from active flags.
4. Summarize every retained cleartext work unit in bounded chunks on an
   eligible, authorized target account. Do not use `compactContextPortable`'s
   budget-fitting path unchanged: its preparation can remove oldest work
   units (`packages/runtime/src/context-compaction.ts`,
   `oldestLogicalUnitCuts`), which is forbidden for this conversion.
   Build a deterministic coverage manifest of original row ids, positions
   and content digests since the clear boundary. Pack complete, ordered
   work units into requests within the target's input/output budgets;
   summarize each, then reduce all chunk summaries through a bounded tree
   until one portable checkpoint fits. Each reduction's manifest covers
   the union of its children. Never discard an unsummarized original unit
   or an unconsumed chunk summary to make a request fit. An indivisible
   unit that cannot fit, an unsupported content type, non-reducing output
   or an exhausted conversion-only call/token budget refuses conversion
   with its exact reason. These are conversion bounds, not healthy-turn
   length limits. Summarization is lossy context compression, not a claim
   of semantic losslessness; full source records remain available.
   Every physical summarization request rechecks funding and target
   eligibility through the core, including explicit pins, effective
   settings and frozen background/personal authority. It never borrows a
   different pool or relaxes a pin when capacity runs out. Tools are
   disabled: summarization describes completed effects, never replays them.
5. One fenced transaction installs the result through a conversion variant
   of `applyContextCompaction`, changes `codex_compaction_mode` from
   `remote_v2` to `portable` only if it is still `remote_v2`, and writes the
   `session.context.compacted` event with `conversion: "remote_to_portable"`.
   Before installation, under the same history-write fence, require that
   the latest clear/compaction boundary and maximum history position still
   match the rebuild's snapshot; any appended row or changed boundary
   invalidates that result. Require complete manifest coverage and all
   chunk requests settled before installation. Original history rows,
   opaque compaction items and original compaction events are never deleted
   or rewritten; only the active model-visible view changes, using the
   existing inactive-row convention. A transaction failure rolls back both
   mode and active-view changes. The mode never returns to `remote_v2`;
   later compactions, on Codex too, are portable.
6. When any block cannot be attributed with certainty, the conversion is
   refused: an event is missing or ambiguous, or a compaction item has no
   event, as in a fork. The fork routine of 0429 and its successors copy the
   source's history rows, inactive ones included, without turn ids, and
   write only a `session.created` event, so a fork's compaction blocks
   cannot be attributed. The refusal is recorded on the session (a new
   `compaction_conversion_refused_at` column), the lock stops being
   convertible, and the session waits with `compaction_provider_locked`, as
   today.

**Supported history and omissions.** Support uncompacted history and the
current integer-position compaction layout when every installed block is
attributable as above, including multiple such compactions and a validated
context-clear boundary. Refuse older fractional layouts, missing or
ambiguous events, forked blocks without provenance, missing source rows,
malformed/unpaired work units and content the target cannot faithfully
process. A coverage manifest cannot recover missing cleartext from an
opaque item. Record the exact supported-layout version and every exclusion
from the request copy: pre-clear history, attributed replacement blocks
and provider-opaque artifacts, with row ranges/counts and reasons. They
remain durably retained; no original cleartext unit after the clear
boundary may be omitted from summarization. Report summarized unit counts,
coverage and exclusions in the conversion receipt/event, without putting
full transcript content in the event. The preview-gated UI in F exposes
the outcome and actionable refusal; this design grants no new UI approval.

**Failure, retries and rollback safety.** Persist staged chunk summaries
and their coverage in a new tenant/session-scoped
`session_compaction_conversion_chunks` relation, not in the event stream
as model input. Key checkpoints by conversion snapshot, algorithm version
and chunk input digest; bind the snapshot to the clear/compaction boundary,
history high-water position, serving provider/model and accepted authority.
Each write is attempt-fenced and links its exact core request receipt.
Reuse a settled successful chunk only for that unchanged snapshot; a
reserved/unknown request is not replayed (D-38). Checkpoints do not activate
history. Crash or Temporal replay after atomic installation reads its
conversion receipt and returns the existing result, without resummarizing,
reinstalling, repeating tool effects or adding accounting entries.

Capacity exhaustion, request failure, cancellation, unknown outcome,
coverage failure or a stale snapshot leaves the old active history and
`remote_v2` mode intact. Report structured reasons such as
`conversion_capacity_unavailable`, `conversion_outcome_unknown`,
`conversion_unit_exceeds_budget`, `conversion_budget_exhausted`,
`conversion_summary_failed` or `conversion_snapshot_changed`, together with
covered/remaining unit counts. Transient capacity waits can resume settled
checkpoints after authorized capacity returns; an unknown outcome requires
settlement first. Stale snapshots must be rebuilt, not installed. Structural
refusals record the unsupported layout or attribution problem and direct
the operator to supported reconstruction or waiting for Codex capacity;
never suggest clearing history or widening access as an automatic fix.

The summary is made on the target because the source provider lacks
capacity. Long history can require multiple billed summarization calls,
but must not be silently shortened to avoid them. Q-05 is resolved as the
implementation approach within the existing objective, not a new owner
decision. Neither E1 nor E2 has a Q-05 approval hold. D-40 supersedes D-19's
premise and the earlier within-Codex-only requirement; verification remains
pending and the runtime is not implemented here. Cross-provider defaults
remain off, D-43's rollout gates remain, and this grants no deployment,
cutover or UI approval. New sessions retain SUB-FAIL-09's portable default.

Scheduled sessions are not affected. The generated-session checks that
compare `codex_compaction_mode` with the accepted binding
(`recoverBoundScheduledTaskDispatch` in
`apps/worker/src/activities/scheduled-tasks.ts`, and migration 0414) run
before a run's first turn, and the reusable-session check
(`assertReusableSessionBindingMatches`) does not compare the mode.

#### 5.7.6 Authority does not change (D-42, D-46)

- Pins and "only this model" never move, and failover never changes a
  person's choice (SUB-SEL-04, SUB-FAIL-05, D-24, D-46). A pin on the home
  provider, or "only this model" there, forbids failover: the turn waits
  (`pinned_account_unavailable` or `pinned_account_ineligible`, including
  #4170's wait on a pin whose account was deleted) instead of moving.
  `failoverCandidateModels` already returns only the preferred model for an
  explicit binding, and the router never runs the step for one.
- A pin on another provider is that provider's own pin under D-32 (#4170).
  It governs only failover onto that provider: the step uses that provider
  only through the pinned account, and only for the row's model under "only
  this model", never through another of its accounts. A pin whose
  account was deleted removes its provider from the candidates. A pinned
  personal account is used only where personal fallback applies (D-12,
  D-28), because the policy picks personal accounts automatically only
  then; automatic failover never relies on an explicit choice to use a
  personal account. The step applies all of this by filtering the
  connections and models it gives the policy, so the pure policy needs no
  change. It never clears or replaces a pin and never changes its account,
  its choice or "only this model"; serving through a pin updates only that
  row's model and clock, as the provider's own `commitBinding` does. Whether
  failover should use such a pin at all, or skip its provider, is open
  (Q-06).
- Every writer locks the row it writes, so a pin racing a failover onto the
  same provider serializes on that row. If the placement commits first, the
  pin then replaces its automatic choice; if the pin commits first, the
  placement finds a changed row (`SubscriptionBindingConflict`) and retries
  under the pin. #4170 is a prerequisite of PR B1 (§5.7.9).
- Personal fallback keeps D-12, and this order is decided: with personal
  fallback on, `decidePlacement` tries the owner's personal account on the
  chosen model before switching model or provider on a shared account (§4,
  step 5). D-28 is unchanged: in the owner's Personal workspace their
  personal account participates automatically, after shared accounts.
  Failover changes neither. Ownership is split: the failover track owns the
  model-order loop of `decidePlacement` (`placement.ts`), and the settings
  and personal track owns personal eligibility (`authorizationIneligibility`
  and `personalFallbackActive` in `packages/subscriptions/src/eligibility.ts`)
  and the explicit-choice path (#4168). Any later change to the order is one
  PR with a conformance test.
- A personal account of the target provider needs that
  provider's frozen personal entry in the accepted authority (v2 freezes
  personal authority per provider, §3.7), authorized in the same
  transaction; the policy's `authorizationIneligibility` already requires a
  frozen entry for the connection's own provider. Nothing is borrowed from
  another provider's entry.
- Background work keeps its accepted pool: shared eligibility stays live and
  personal authority stays frozen per provider, as for any placement, and a
  switch adds no authority. Private-session access is never widened
  (SUB-ELIG-05).
- Ownerless sessions use shared accounts only and write no binding, as in
  M4.
- Workspace model restrictions and provider switches remove candidates
  (SUB-ELIG-02, SUB-SET-06, D-17, D-26). A restricted preferred model falls
  through to the next permitted candidate, which may be on another provider.
- Stickiness checks forced reasons before warmth (D-31), so a warm cache
  never keeps an account the session may no longer use, on any provider.

#### 5.7.7 Default and rollout (D-43, D-44)

The default is off everywhere on main. The Codex cutover wrote `false` for
existing organizations (0689), the generic seed writes `false` for new ones
(0712), the resolver reads a missing value as `false`
(`coalesce(org.cross_provider_failover, false)` in 0642 and 0644), and the
settings API's values for an organization without a row are `false`
(`SEEDED_ORGANIZATION_VALUES` in `packages/db/src/subscription-settings.ts`).
Migration 0724 added locks and changed no default. Placement then forces the
value off (`providerPlacementInput` in `turns.ts`), so the stored setting has
no effect yet.

No PR in this plan changes a default or a stored value. M4's per-provider
routine keeps forcing the setting off, and only the step reads it. Whether
new organizations start with it on is the owner's decision (Q-02). Because
the settings API already lets organizations store `true`, the runtime ships
dormant behind a deployment setting that is off by default (D-43). It is
enabled only after staging verification and after PR F ships.

#### 5.7.8 Temporal

No workflow code changes. The session workflow
(`apps/worker/src/workflows/session.ts`) already handles both shapes a
switch uses: the `recovering` result, which re-runs the turn, and
`capacityWait`, handled by `waitForProviderCapacity`, which passes the wait
reference's `provider` to the `reconcileCodexCapacityWait` activity.
`CodexCapacityWaitRef.provider` (`apps/worker/src/activities/types.ts`)
keeps one of its existing values, because the waiter keeps the session's own
provider (D-41), and the activity evaluates every candidate itself. The wake
signal (`codexCapacityChanged`) and the wake revision are unchanged. So no
`patched()` branch is needed.

Replay tests still guard this. PR C2 adds a recorded history in which a
capacity wait resolves into a turn placed on another provider, and PR D one
in which a mid-turn refusal recovers onto another provider. Both replay with
`Worker.runReplayHistory` in
`test/integration/subscription-core-codex-wait.integration.ts` and
`test/integration/temporal-workflow.integration.ts`, next to the existing
legacy capacity-wait fixture.

#### 5.7.9 Implementation PRs

#4170's per-provider bindings are a prerequisite of PR B1, and the open M4
stacks still change most files this feature needs, so the plan has two
phases. Phase 1 adds new files plus the one optional `adapter.ts` member the
M4 owners agreed to. B1's mirrored request-fence edit also waits for #4170;
the other pieces can merge while those stacks are open. Phase 2
is a set of small hook PRs, and each names the open PRs it waits for. Every
PR stays dormant until D-43's deployment setting is on.

Merge order: A first; then C1; then B1 once #4170 has merged; E1 after A,
without waiting for Q-05. Phase 2 follows the M4 merges: A2 per provider, B2, C2,
D, E2, H, and F last.

Migrations take the next free number when they merge. The initial scan
ended at 0728 with five candidates claiming 0729. #4170 has since landed
as 0733; 0729 in §5.6 is the distinct personal-preferences migration and
must not be renumbered. Future numbers are settled from the live ledger.
Each migration is added to the three migration lists
(`scripts/release-schema-contract.test.ts`,
`packages/db/test/embedding-migration-tail.ts` and
`packages/db/test/migration-0598-claude-subscription-pools.test.ts`). Tests
name the SUB-FAIL ids they assert, and real-PostgreSQL tests run as the
non-owner application role.

**Contended files.** The open subscription-track PRs that change a file this
plan needs, scanned on 2026-10-12 at 05:40 UTC. This is a historical
coordination snapshot; #4168 and #4170 have since merged and their listed
prerequisites are satisfied. Rescan before each hook PR.

| File | Open PRs that change it | Plan PR that edits it |
| --- | --- | --- |
| `packages/db/src/subscription-core/turns.ts` | #4130, #4157, #4159, #4170 | H |
| `packages/db/src/subscription-core/requests.ts` | #4170 (targeted rescan for this revision) | B1, after #4170; rescan before editing |
| `packages/db/src/subscription-core-placement-world.ts` | #4132, #4158, #4170 | none |
| `packages/db/src/subscription-core/waiters.ts` | #4118, #4132, #4137 | B2 |
| `packages/subscriptions/src/adapter.ts` | #4130, #4132, #4137, #4157, #4158, #4159 | A (one optional member) |
| `run.ts`, `turn-context.ts` and `failure-settlement.ts` in `apps/worker/src/activities/agent-turn` | #4118, #4129, #4132, #4139, #4158 | C2, D |
| `stream-attempt.ts` in the same directory | #4118, #4132, #4139 | C2 |
| `claim.ts` in the same directory | #4158 | C2 |
| `subscription-core-capacity.ts` in the same directory | #4118, #4132 | C2 |
| `codex-core-capacity.ts` in the same directory (arms the wait) | #4118, #4132, #4158 | C2 |
| `apps/worker/src/activities/subscription-core-codex-waits.ts` (reconciles the wait) | #4118, #4132 | C2 |
| `subscription-core-failover.ts` in `agent-turn` | created by #4118, also changed by #4132 | D |
| `packages/core/src/domain/sessions.ts` | #4129, #4130, #4157, #4158, #4159 | E2 |
| `packages/contracts/src/index.ts` | #4168 | C1 (one export line), C2 (event type) |
| `packages/db/src/index.ts` | #4104, #4118, #4129, #4130, #4131, #4132, #4139, #4157, #4158, #4159, #4168, #4170, #4172 | B2, C2, E2 |
| `packages/db/src/subscription-core-codex-adapter.ts` | #4130, #4157, #4159 | A2 |
| `packages/db/src/subscription-core-xai-adapter.ts` | #4104, #4130, #4157, #4159 | A2 |
| `packages/db/src/subscription-core-claude-adapter.ts` | #4130, #4132, #4137, #4157, #4158, #4159 | A2 |
| `packages/db/test/helpers/subscription-core-conformance.ts` | #4118, #4130, #4132, #4137, #4157, #4158, #4159, #4168, #4170 | none |
| `packages/subscriptions/test/policy.test.ts` | #4130, #4137, #4157, #4159 | none |
| `packages/db/test/subscription-core-fake-api-key-conformance-postgres.test.ts` and its fixture | #4130, #4157, #4159 | none (B1 imports the fixture) |
| `packages/db/src/subscription-core/provider-route.ts` and `packages/db/src/subscription-core-providers.ts` | #4104 (both), #4137 (the registry) | none (read only) |
| `packages/db/src/subscription-core-repository.ts` | #4170 | none (B1 uses #4170's binding API) |
| The three migration lists | #4104, #4130, #4131, #4137, #4157, #4159, #4168, #4170, #4173 | B1, B2, E1 (one added line each) |

No open subscription-track PR changes the other files the plan edits:
`types.ts`, `placement.ts`, `settings.ts`, `reference-model.ts` and
`reference-bridge.ts` in `packages/subscriptions/src`,
`reference-conformance.test.ts`, `packages/config/src/index.ts`,
`apps/worker/src/activities/run-input.ts`, `compaction-prep.ts` in
`agent-turn`, `apps/worker/src/activities/context-compaction.ts`,
`packages/core/src/goal-admission.ts`, the runtime's compaction module, the
test-provider helper (`packages/db/test/helpers/subscription-core-test-provider.ts`)
and the replay tests in `test/integration`. Older open PRs outside these
tracks, such as #2716 and #3278, also change some of the worker and
configuration files; the rescan before each hook PR includes them.

**Phase 1: new files and narrowly ordered edits.**

**PR A: pure policy and the adapter capability.** No database or worker
behaviour changes.

- `packages/subscriptions/src/types.ts`: `ModelTier` and the optional
  `ModelDescriptor.tier`.
- `packages/subscriptions/src/adapter.ts`: the optional
  `SubscriptionCoreAdapter.modelTier?`, the one agreed edit. It only adds
  lines, so it rebases onto the seven open PRs that change the file.
- `packages/subscriptions/src/settings.ts`: `hasFallbackOrderEntry`, next to
  `fallbackOrderFor`.
- `packages/subscriptions/src/placement.ts`: `failoverCandidateModels`
  derives the same-tier order (a new `derivedFallbackOrder`) when the
  preferred model has no entry and cross-provider failover is on. The
  model-order loop of `decidePlacement` is unchanged (D-12, D-42).
- `packages/subscriptions/src/reference-model.ts` and `reference-bridge.ts`:
  an independent derived order, and a mutation the conformance must catch.
- Tests, no network, under SUB-FAIL-03 and SUB-FAIL-04: a new
  `packages/subscriptions/test/failover-policy.test.ts` (four open PRs change
  `policy.test.ts`) and cases in `reference-conformance.test.ts`. An explicit
  entry wins; an explicit empty list derives nothing; the derived order keeps
  the same tier and skips models without one; nothing is derived when the
  setting is off, for "only this model" or for an explicit binding; levels
  map by D-16. The existing D-12 order cases stay unchanged.
- Waits for nothing open. M4's placement forces the setting off, so nothing
  reaches the derived order yet.

**PR B1: the core step in new modules.** One migration. It needs #4170
merged.

- `packages/db/src/subscription-core/failover.ts`: the router
  `placeSubscriptionCoreTurnWithFailover`, the step,
  `evaluateSubscriptionCorePlacementWithFailover`,
  `countSubscriptionCoreTurnRefusalsAcrossProviders`,
  `earliestHealthRetryAtAcrossProviders`, the target filter over
  `readSubscriptionCoreProviderRoute` and 0733's rolling index (D-34,
  D-46), the continuity read over C1's
  `readSubscriptionCoreServingPolicyForTurn`, the pin filters, the
  provider-neutral copy of `commitBinding`'s rules, and the copies of
  `readAttemptFence` and `readLastContextReplacedAt`.
- `packages/db/src/subscription-core/failover-world.ts`:
  `withSubscriptionCoreFailoverPlacementWorld`, which locks the home and
  candidate rows in provider-id order through #4170's
  `readSubscriptionSessionBinding`. The repository is not edited.
- Nothing is exported from `packages/db/src/index.ts` until C2 adds the
  first caller; tests import the modules by relative path.
- Migration: the admission trigger's unresolved-outcome test. Drop the
  prior-provider predicate and restrict the earlier-generation
  closed-attempt exemption to SAME-provider requests (§5.7.4), with an
  anchored replacement as 0707 does. In
  `packages/db/src/subscription-core/requests.ts`, change the mirrored
  `reserveTurnRequest` query identically, after #4170. Prior unresolved
  requests count even when their provider is no longer registered. The
  test still compares model requests only, so media operations never fence
  a turn. The bindings table is not changed.
- Tests, real PostgreSQL as the application role, in a new suite
  (`packages/db/test/subscription-core-failover-postgres.test.ts`) with its
  own helper, because nine open PRs change the shared conformance helper. It
  registers two test providers through `testSubscriptionCoreProviderModules`,
  and the fake API-key connector runs the same cases from its fixture
  (SUB-PROV-04):
  - The hard requirement (D-34, SUB-FAIL-04): a provider with a registry
    entry, an enabled switch row and core connection rows written by the
    database owner but no receipt is never a target, and none of its
    accounts is leased; a cutover whose transaction has not committed is not
    seen; a provider in `maintenance` is skipped; after the commit it is a
    target.
  - The rolling window (D-46): while 0733's index exists the step never
    offers another provider's model, and same-provider fallback still works;
    a renamed matching index, reversed key order, INCLUDE columns and a
    partial or invalid matching index still block crossing. A failed or
    uncertain catalog read fails closed. With the index dropped by the
    database owner, as the drained cutover drops it, the same session
    crosses. A schema/cutover ordering test verifies that a drained
    cutover after 0733 retargets binding upserts to the provider key and
    removes the rolling uniqueness after its drained preflight but before
    writing target-provider bindings. Verify that previous binaries cannot
    return, the provider-fixed trigger stays enabled or its invariant is
    checked, and failure rolls back the drop and data move atomically.
  - Pins (D-46, SUB-FAIL-05, SUB-WAIT-01): a home pin, a home pin whose
    account was deleted and "only this model" wait and never move; a pin on
    a target provider is used only through its pinned account, and only
    through its model under "only this model"; a target pin whose account
    was deleted removes its provider; a pinned personal target is used only
    where personal fallback applies; no pin's account, choice or "only this
    model" ever changes.
  - Rows (D-36): a crossing writes only the target row and never the home
    row; a return writes only the home row; no row changes provider; the
    0723 clock; a lost first-insert race retries; a pin racing a failover
    onto the same provider serializes.
  - Continuity (SUB-FAIL-07, D-36): a warm fallback is kept through the
    previous claimed turn's serving revision; the session returns only once
    the fallback is cold; a change of the session's model ends the fallback;
    a lease row left on another provider (D-33).
  - The fallback order and tiers end to end (SUB-FAIL-03); ownerless
    sessions use shared accounts only and write no binding; the D-12 order
    and per-provider personal authority; workspace restrictions, provider
    switches and the compaction-lock wait (SUB-FAIL-04, D-42).
  - The earliest reset and health retry across providers (SUB-WAIT-01,
    D-41).
  - The widened fence (D-38, SUB-FAIL-08): unknown and other-attempt
    reserved source requests refuse a target request with the source
    attempt open; then drive `requestSessionTurnRecovery`, verify its
    `interrupted_recoverable` closure, reclaim through
    `claimSessionWorkForAttempt` and verify the incremented generation
    still cannot reserve on the target. Cover `failed` and
    `lease_lost_recoverable` closures and a subsequently unregistered
    source too. Test the typed `reserveTurnRequest` refusal and direct SQL
    trigger separately, and keep same-provider recovery exemption cases.
  - A concurrency test: two sessions crossing in opposite directions, a pin
    of one target, a credential refresh of the other, a disconnect, a
    same-turn request reservation and a post-commit fenced selection write,
    under a bounded lock timeout, with no deadlock and with lease and
    binding in agreement. Assert placement has committed before any
    serving-revision, pending-target or switched-event write acquires the
    turn write fence.
  - The copies give the same result as `turns.ts` for the fenced, compacted
    and binding-commit scenarios.
- Waits for A, C1 and #4170, including #4170's `requests.ts` changes. Rescan
  that file before implementing the mirrored fence; if another M4 request
  writer is open, serialize this edit after it, never omit the mirror.
  Other contended edits are only the migration lists. It reads
  `provider-route.ts` and the registry, which
  #4104 and #4137 change, so it rebases if their signatures move.

**PR C1: the serving revision.**

- `packages/contracts/src/turn-serving-policy.ts` (new):
  `TurnServingPolicyV1`, its metadata key `turnServingPolicyV1` and its
  reader, re-exported from the contracts index with one line (#4168 adds a
  line beside it).
- `packages/db/src/subscription-core/serving-policy.ts` (new):
  `recordSubscriptionCoreServingPolicyForTurnAttempt` under the attempt
  fence (`lockTurnAttemptWriteFenceTx`), refusing a turn with a credential
  restriction, and `readSubscriptionCoreServingPolicyForTurn`. One
  immutable revision per `(turn, generation)`; matching retries return it
  and conflicting rewrites fail. Add pure validation and a transaction-local
  pending-target helper for C2's recovery hook; do not nest a new fence or
  transaction inside placement. Pending targets never count as revisions.
- `packages/config/src/index.ts`: the serving variant of
  `assertTurnExecutionPolicyMatchesConfigV1`, and D-43's deployment setting,
  off by default.
- `apps/worker/src/activities/run-input.ts`: the provenance projection of
  §5.7.4, pure and not yet called.
- Tests: the schema and the configuration checks, no network; the projection
  (rows of the serving provider keep their artifacts, rows of another
  provider lose them, rows without a turn keep today's projection;
  SUB-FAIL-08); a real-PostgreSQL test of the fenced writer, in which a
  fenced-out attempt cannot record, duplicate recording leaves one revision
  and the same budget, conflicting same-generation policies are refused,
  and identical policies in later generations consume no transition budget.
- Waits for nothing open.

**PR E1: the conversion pieces.** One migration. Q-05 is resolved within
the delegated unlock objective; this does not activate conversion.

- `packages/subscriptions/src/placement.ts` and the reference model: the
  convertible compaction lock and `convertsCompaction` (§5.7.5, step 1). The
  lock converts only when cross-provider failover is allowed and the input
  says the session has no refusal, so M4's placement, which forces the
  setting off, never converts.
- `packages/runtime/src/compaction-conversion.ts` (new): the rebuild,
  supported-layout validator, coverage manifest and deterministic bounded
  chunk/reduction planner of §5.7.5. Refuse any unattributable block or
  unsummarized-unit omission; do not reuse oldest-unit trimming.
- `packages/db/src/context-compaction-conversion.ts` (new): one read of the
  rows and compaction events since the latest clear marker, the fenced
  install (the conversion variant of `applyContextCompaction`, the one-way
  mode change and the event), refusal record and idempotent staged chunk
  checkpoints tied to exact request receipts and the immutable snapshot.
- Migration: `sessions.compaction_conversion_refused_at` and the scoped
  `session_compaction_conversion_chunks` relation with FORCE RLS, exact
  tenant/session keys, unique snapshot/chunk identity and fenced writers.
- Tests under SUB-FAIL-09: the rebuild over several remote compactions, a
  context clear, a fork, a missing event, a fractional historical layout
  and ambiguous timestamp/turn attribution (all refused), no network; real
  PostgreSQL for the atomic install and mode change, the one-way mode, the
  refusal record, an archived session and an append or context change
  between rebuild and install (the stale install is refused). Test
  all-unit coverage through multiple reduction levels, over-budget units,
  unsupported content, no reduction, budget exhaustion and recorded
  exclusions, with scripted no-network summaries. PostgreSQL tests as the
  non-owner app role cover checkpoint isolation, duplicate writes, failed
  final commit rollback and byte-for-byte preservation of original history
  items and compaction records apart from the intended active flags.
- Waits for A, which changes `placement.ts` first, and for nothing open.

**Phase 2: hooks, each after the open PRs it names.**

**PR A2: tier declarations.** One small PR per provider: each adapter module
declares `modelTier` for its models, outside the shared directories. Codex
(`subscription-core-codex-adapter.ts`) waits for #4130, #4157 and #4159;
SuperGrok (`subscription-core-xai-adapter.ts`) for #4104, #4130, #4157 and
#4159; Claude (`subscription-core-claude-adapter.ts`) for #4130,
#4132, #4137, #4157, #4158 and #4159. Tests: the declarations in each
adapter's tests, and a case in the failover suite that every declared tier
is a `ModelTier` and undeclared models have none.

**PR B2: waits across providers.** In
`packages/db/src/subscription-core/waiters.ts`, a capacity wake also matches
waiters whose `candidate_providers` include its provider, in BOTH the
initial read and final UPDATE predicates. Preserve the workspace/session
lock order. The generic
arm that #4118 adds to `packages/db/src/index.ts`
(`armSubscriptionCoreCapacityWait`) records candidates from
`evaluateSubscriptionCorePlacementWithFailover`; reconciliation refreshes
them. In the same file, the next-check helper caps failover-aware waits by
the existing backoff even when a reset is known (§5.7.2).
Migration: `subscription_capacity_waiters.candidate_providers` plus a GIN
index for the any-match query. Tests, real PostgreSQL: a candidate wake
increments the waiter's revision and enqueues its wake, a non-candidate
does not, and settings/model/pool/cutover changes outside the old candidate
set are observed at the bounded recheck, including a far-future known
reset and a lost mutation wake (SUB-WAIT-01/02, D-41). Waits for #4118, #4132 and
#4137, which change `waiters.ts`.

**PR C2: the worker switch between turns.**

- `claim.ts`: claim with the serving revision (the configuration check,
  `ensureRunAllowed` and `assertSessionAllowsProductModel` with the serving
  model).
- `turn-context.ts`: the billing flags and runtime configuration come from
  the latest serving revision.
- `run.ts` and `subscription-core-capacity.ts`: core placement goes through
  `placeSubscriptionCoreTurnWithFailover`; a placement on another model
  stages the pending target and restarts the attempt
  (`requestSessionTurnRecovery`).
- `stream-attempt.ts`: passes the serving provider and the history
  provenance to `turnInput`, which applies C1's projection while D-43's
  setting is on.
- `codex-core-capacity.ts` and `subscription-core-codex-waits.ts`: arming
  records the candidate providers, and reconciliation is handed
  `evaluateSubscriptionCorePlacementWithFailover`.
- `CoreTurnPlacementProvider.recordSelection` records
  `subscription.account.switched` referencing the serving revision in a
  separate fenced transaction after placement commits; a pending target
  does not emit a switch. The event
  type joins `SessionEventType` in `packages/contracts/src/index.ts`.
- `packages/db/src/index.ts`: exports the functions of B1 and C1 and extends
  `RequestSessionTurnRecoveryInput` / `requestSessionTurnRecovery` to
  validate and persist the pending target in the recovery transaction.
  Claim consumes it into exactly one revision for the new generation.
- Tests, no network, under SUB-FAIL-01, SUB-FAIL-03, SUB-FAIL-06 and
  SUB-FAIL-08: claim with a serving revision, routing and restart, the
  request copy; the replay test of §5.7.8. Real PostgreSQL repeats B1's
  same-turn reservation race with the actual selection/event hook, proves
  no turn write fence is acquired while placement holds bindings, and
  tests crash/retry between placement, recovery proposal, claim and event
  publication without duplicate revisions, events or budget charges.
- Waits for A, B1, C1 and B2, for #4118, #4129, #4132, #4139 and #4158 (the
  worker files), and for #4168, which adds an event type in the same enum.
  New worker code is provider-neutral, so it passes the extension
  of `check:subscription-core-neutral` to the worker that §5.3 (X1a) lists
  as a follow-up.

**PR D: the worker switch mid-turn.**

- `subscription-core-failover.ts` (#4118's `failOverCoreSubscriptionTurn`):
  evaluate before requesting recovery and stage the pending target with
  the request; apply the bound across providers (B1's refusal count plus the
  actual provider/model transitions between committed revisions, D-39);
  refuse to switch on any
  unresolved request of any provider (D-38).
- `failure-settlement.ts` (`settleTurnFailure`): route core refusals to it.
- Tests under SUB-FAIL-08 and SUB-FAIL-11: completed tools and accounting
  kept without duplicates, and an unknown outcome blocks the real
  `failOverCoreSubscriptionTurn` → recovery → reclaim → target reservation
  path. Cover the bound across providers, a provider put on hold after a
  refusal, duplicate recording, warm-fallback baselines and repeated
  identical policies; the replay test of §5.7.8.
- Waits for C2, and so for the same open PRs.

**PR E2: the conversion hooks.** No additional Q-05 source-implementation hold.

- `compaction-prep.ts` and `apps/worker/src/activities/context-compaction.ts`:
  an attempt whose serving revision carries the conversion runs it before
  its first ordinary model call, through E1's all-unit chunk planner and
  resumable reduction executor, and `maybeCompactContext` accepts it.
  Each summarization call reserves and settles through the authorized
  target's core request/funding path with tools disabled.
- `packages/core/src/domain/sessions.ts` (`assertSessionAllowsProductModel`)
  and `packages/core/src/goal-admission.ts`: accept a pending conversion.
- `packages/db/src/index.ts`: `applyContextCompaction` records
  `supersededFrom` and the block length in new events, and E1's functions
  are exported.
- The step passes the convertible lock when the session has no refusal.
- Implement the revised SUB-FAIL-09 / D-40 contract; requirement
  verification stays pending until the implementing tests pass.
- Tests under SUB-FAIL-09: `packages/runtime/test/context-compaction.test.ts`,
  `apps/worker/test/context-compaction-activity.test.ts`, and a refusal
  followed by the `compaction_provider_locked` wait. Cover long-history
  target exhaustion mid-tree, failed/empty summaries, unknown requests,
  lost authority, source/target pins, frozen background pools and funding
  refusal: no truncated install and no alternate unauthorized account.
  Crash/retry and Temporal replay tests cover settled chunk reuse, unknown
  outcome fencing, failure before final commit and replay after it, with
  no duplicate tools, requests or accounting and unchanged original records.
- Waits for E1, C2 and D, and for #4129, #4130, #4157, #4158 and
  #4159 (`sessions.ts`).

**PR H: cleanup.** `turns.ts` uses B1's copies of `readAttemptFence`,
`readLastContextReplacedAt` and `commitBinding`'s rules, so one version
remains. The rolling-index check is removed only when the next drained
provider cutover, whichever lands first, has shipped with proven removal
of rolling uniqueness in every supported migration path. Waits for #4130,
#4157, #4159, #4170 and that cutover; do not infer removal from a PR number.

**PR F: events and UI, preview-gated.** The web timeline row for
`subscription.account.switched`, the session indicator showing the serving
model, and a short notice of the switch. It needs real-component preview
screenshots and owner approval before merge (D-08, D-45), and it coordinates
with #4123 (account rules) and #4168 (the account picker). Enabling D-43's
deployment setting waits for this PR.

**Coordination points.**

- #4170, the per-provider bindings (decision D-32, migration 0733), has merged,
  satisfying this design PR's and B1's prerequisite. Its rules and D-36 and D-46
  must stay aligned: each provider
  writes only its own row, no row changes provider, a pin whose account was
  deleted waits, and every writer locks its row and compares its version. If
  #4170 changes `providerPlacementInput`, `commitBinding` or the binding API
  again, B1's commit copy and tests are rechecked. Q-06 is the question to
  settle with its owner.
- The next drained provider cutover, whichever lands first, must drop
  0733's rolling index after its preflight excludes other runtime logins
  and before any target-provider binding write. The previously inspected
  #4104 migration (`0718_subscription_core_xai_cutover.sql` at that snapshot)
  used `ON CONFLICT (workspace_id, session_id)`; retarget it to
  `(workspace_id, session_id, provider)`. Dropping only after the old
  upsert is not an alternative: a target insert can collide with an
  existing home binding. No previous binary may run after the drop, since
  its unscoped reads and updates are unsafe without the rolling uniqueness.
  Preserve `subscription_session_bindings_provider_fixed` during the bulk
  move, or assert afterwards that no pre-existing row changed provider.
  Preflight, drop, move and verification retain the drained atomic cutover
  rules. If a cutover precedes 0733, arrange a later drained removal and
  prove its ordering. Until actual removal, no crossing.
- #4168 owns §5.6 and the explicit-choice writer, whose pins become per
  provider under #4170; PR F coordinates with its picker (#4169).
- Step R (#4173), which retires the per-provider SQL functions, must keep
  B1's widened unresolved-outcome test. Its migration does not touch that
  trigger today, but a later rewrite of it from an older copy would narrow
  it again silently, so B1's real-PostgreSQL case must stay in the suites
  step R runs.
- Migration numbers are settled at merge, as above.

**Risks.**

- The M4 PRs still move the hook files, so every phase 2 PR rebases on them;
  the table above is a snapshot.
- Until PR H, the fence and compaction reads exist twice; B1's copy cases
  catch drift.
- A lock-order mistake would deadlock placements; the concurrency test
  guards it, including same-turn reservation versus post-commit selection.
  Candidate-row locks briefly delay a pin in the same session.
- Route and operator-switch reads are plain reads, as in M4: an operator
  hold committed during placement can still allow one lease. This design
  does not claim immediate serialization of that hold with placement.
- A switch after an unresolved request could spend twice; the widened fence
  and the worker check close that.
- Waking every candidate provider's waiters widens the wake fan-out.
- Analytics that read the accepted policy (0533) attribute a fallback turn
  to the accepted model.
- Summaries can lose detail despite complete structural coverage; original
  durable records remain intact. Long-history conversion may exhaust its
  budget or target capacity and fail closed instead of omitting units.
- A quarantined personal account's health retry falls back to the waiter's
  backoff, a limit inherited from #4105.
- Until the next drained cutover drops 0733's rolling index, the step never
  crosses providers. The definition-based catalog check also blocks a
  renamed matching index and fails closed on catalog uncertainty, until
  PR H proves it can remove the check.
- Until Q-06 is decided, a pin on a fallback provider limits failover there
  to the pinned account.

## 6. Specific behaviours

### 6.1 Cache coldness (SUB-STICK-04)

Each adapter declares its cache lifetime as a capability
(`SubscriptionCoreAdapter.cacheFacts`, a positive exact TTL or idle cut-off;
`declaredCacheLifetimeMs` refuses anything else), and shared code names no
provider and has no provider default:

| Adapter | Declared lifetime | Source |
| --- | --- | --- |
| Claude | exact TTL, 5 minutes (the `cacheTtl` Opengeni sends) | Anthropic prompt caching: the default cache lifetime is 5 minutes, refreshed on each use (https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| Codex | idle cut-off, 60 minutes | OpenAI prompt caching: in-memory retention keeps prefixes for about 5 to 10 minutes of inactivity, up to one hour (https://developers.openai.com/api/docs/guides/prompt-caching) |
| SuperGrok | will declare an idle cut-off of 60 minutes when its core adapter lands (M4) | xAI documents no lifetime and says cached prefixes can be evicted at any time (https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices) |
| Test API-key connector | idle cut-off, 20 minutes | deliberately unlike the real adapters, so conformance reads the lifetime from the adapter |

Core placement validates the declaration (`declaredCacheLifetimeMs`) when it
builds the world and fails closed on anything but a positive whole number of
milliseconds. The reference model's `DEFAULT_IDLE_CUTOFF_MS` applies only to
legacy cache facts without a cut-off, never to a core adapter.

Until per-provider cut-offs are measured from `model_call_facts` (which
gains `connection_id`, also needed for SUB-ACCT-01), erring towards "warm"
avoids paying a cache miss for a switch that was not needed, at the cost of
returning to the preferred account later.

`bindingStickiness` (pure policy) decides whether an automatic binding keeps
its account. Forced reasons come first, so a warm cache never keeps an
account the session may not use: the account is gone from the session's
world (`account_unavailable`: removed, out of scope), cannot serve
(`account_ineligible` with the eligibility reasons: exhausted, rate-limited,
unhealthy or quarantined, disconnected, switched off), its model may not be
used (`model_not_permitted`), or it would spend paid credits while another
account has included allowance (`extra_credits`). Then re-selection points
(`reselection_point`: compaction, model change) and finally the clock
(`cache_cold`: idle longer than the declared lifetime, or no clock, which is
how a pin change shows up). Idle exactly the
lifetime is still warm. The reported reason is the first that applies and is
diagnostic only. A re-selection runs normal selection (rotation
applies) and may land on the same account. Core placement reports the reason
as `reselection` on a run (null when the warm account was kept, for an
explicit choice and for a reused lease). Explicit pins, personal-account
rules, background pools and the ownerless shared-only rule are unchanged.

### 6.2 Events (SUB-FAIL-06)

`subscription.account.switched { provider, fromConnectionId, toConnectionId,
fromModel, toModel, reason }` with reason in `initial`, `reselected_cold`,
`failover_same_provider`, `failover_cross_provider`, `return_to_preferred`,
`explicit_choice`, `revoked`; and `subscription.capacity.waiting { reason,
earliestResetAt }`. Existing Codex account-switch events remain as aliases
for current clients (SUB-COMPAT-02). §5.7.4 says when the switch event is
written and how the indicator follows it (D-45).

### 6.3 Codex Apps and reset credits (SUB-APPS-01, SUB-APPS-02)

Apps credentials load by their designation, never through placement. Any
organization administrator or the connection's delegated manager may
designate or clear Apps in any routing mode. Reset-credit redemption stays
human-only from a browser session, allowed to organization administrators
and delegated managers of that connection (not "whoever connected it").

### 6.4 Compaction (SUB-FAIL-09)

Remote compaction's active replacement contains an opaque encrypted item
and retained user/system/developer messages, but Opengeni also retains the
original inactive cleartext rows (`applyContextCompaction`, §5.7.5).
New sessions with an effective cross-provider fallback use portable
compaction. Existing sessions convert at their next compaction while Codex
has capacity, or at failover on an eligible authorized target using D-40's
complete-coverage chunked summarization. Original history and compaction
records stay intact; only the active model-visible view changes atomically
with the mode. Unsupported attribution, omitted cleartext units, exhausted
budgets or incomplete summaries leave the original mode/view unchanged
with an actionable reason. Q-05 is resolved within implementation scope;
verification remains pending and deployment/default/UI gates are unchanged.

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
