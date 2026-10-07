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
    `enabled` (bool). These express today's Codex workspace modes without
    touching connection scopes or the model allowlist (§5.2).
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
  provider; the owner membership is derived from the initiating human at
  cutover. Shared eligibility is never frozen.
- Agent messages and Steer take the receiving session's value; non-human
  acceptance (API keys, operators, Slack, service schedules) freezes no
  personal authority (SUB-ACCESS-01).
- The inbox execution-context fence (0608) and scheduled admission (0275,
  0478) compare `subscription_authority` instead of the per-provider columns.
- At each provider cutover the migration backfills v2 on all live rows,
  including scheduled tasks, inside the owner window, so no v1 reader
  survives.

### 3.8 Authorization and row-level security

- Shared connection rows are visible to administrators and to workspaces in
  scope; people scope is evaluated against the **session owner**, the person
  whose session spends the account.
- Personal rows are usable only for work whose session owner is the owner and
  whose accepted authority lists that provider and owner, in the owner's
  private sessions or Personal workspace. The check is a `SECURITY DEFINER`
  function that takes the session owner and the turn's human as explicit
  arguments and reads memberships through the existing per-transaction
  capability pattern (0234), never through an empty subject.
- Binding, lease, waiter and failure rows reference the session and inherit
  `session_visibility_isolation`. Core operations run with the acting turn's
  initiating human (`withSubscriptionPoolSessionAccess`, SUB-ACCESS-02..04).
  Turns with no initiating human run as `service:subscription-core` with the
  session owner as initiating human only for that session, using the same
  capability pattern; they never get personal authority.
- Membership removal (0263) learns the `subscription_connection` resource
  kind and revokes personal connections on leave (SUB-ACCESS-06).

## 4. Placement

One transaction per placement, following the canonical lock order:
workspace control, then session, turn and attempt, then the session binding
row (created with `INSERT … ON CONFLICT DO NOTHING` before it is locked).
No provider call happens inside it.

1. Read effective settings (SQL).
2. If the binding is `explicit`, use that connection or wait
   (`pinned_account_unavailable`).
3. Candidate models: the preferred model, then the fallback order (same or
   other providers, the latter only if cross-provider failover is on and the
   session is not "only this model"), filtered by workspace restrictions,
   connection `allowed_model_ids`, entitlements and per-model cooldowns. A
   preferred model the workspace does not allow falls through to the allowed
   candidates, and the session waits only if none is allowed (D-17).
4. Keep the bound connection if it can still serve its model, the cache is
   warm, and no re-selection point applies (compaction completed, model
   changed, session became shared while on a personal account).
5. Otherwise, per candidate model: shared connections that can serve it,
   ordered by rotation (the primary first, regardless of whether its quota
   is known), then by known capacity before unknown, then by a deterministic
   hash of the session id; then, with personal fallback, the owner's
   personal connections for the same model; then the next model.
6. Nothing servable: arm the session waiter with the earliest known reset.

Mid-turn failover happens only between model calls: the turn records a new
execution-policy revision, re-runs the funding check (`ensureRunAllowed`)
for the new provider, drops provider-specific history items from the request
copy (`historyCompatibility`), and keeps completed tools and accounting.
Image and video operations key their idempotency on the turn and call, not
the credential, so a failover cannot spend twice (SUB-ACCT-02).

The reference model (`packages/testing/src/subscription-reference-model.ts`)
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

### 5.2 Legacy shape mapping

| Legacy | New |
| --- | --- |
| Workspace-scoped credential in a shared workspace | Shared connection scoped to that workspace, managed by it. |
| Workspace-scoped credential in a Personal workspace | Personal connection owned by that workspace's owner. To keep their Personal-workspace sessions working, the owner's `personal_fallback_opt_in` is set (D-18). |
| Organization credential with `allowed_workspace_ids` / `allow_personal_workspaces` | Shared connection: `organization` scope when the list is NULL, otherwise `workspaces` scope with the same list. |
| User-scoped credential (xAI, Claude) | Personal connection for the same membership, no longer bound to one workspace. |
| Codex `automatic` | No override. Where the workspace has local accounts, the workspace's Codex rotation becomes `primary_first` with its active local account as primary, or `spread` if its rotation was on, so local accounts keep taking new work. |
| Codex `workspace` | Workspace override `use_organization_accounts = false` for Codex. |
| Codex `organization` | The workspace's local Codex connections were not being used; they are kept as shared connections assigned to no workspace (shown as "not assigned" to administrators), so only organization accounts serve the workspace, as today. |
| Codex `disabled` | Workspace override `enabled = false` for Codex. |
| Rotation rows | Only the rows for the pool currently in effect are mapped (organization row to organization settings, workspace rows to workspace overrides). Rotation off maps to `primary_first` (D-13). Personal-pool rotation rows have no equivalent and are dropped (documented). |
| Codex session pin/last columns; xAI/Claude pin rows | One chat binding per session: a manual pin becomes `explicit`; otherwise the most recent pin or last account becomes `automatic` with `last_model_call_at` from the latest model call. Several per-pool rows collapse to the one for the session's current model provider. |
| Leases, waiters | Moved with generation and wake revision; several per-pool waiters on one session collapse to the waiting one for the blocked turn. |
| Codex Apps designation | `subscription_apps_designations (workspace_id, connection_id, version)`; any in-scope connection may be designated (§6.3). |

## 6. Specific behaviours

### 6.1 Cache coldness (SUB-STICK-04)

Claude: idle longer than the TTL OpenGeni sent. Codex and SuperGrok: a
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
- SQL and TypeScript effective-settings parity.
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
