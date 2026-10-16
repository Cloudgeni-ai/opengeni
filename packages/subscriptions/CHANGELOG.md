# @opengeni/subscriptions

## 3.3.0

## 3.2.2

## 3.1.2

## 3.0.0

### Patch Changes

- 99ab991: Distinguish scheduled runs skipped because their chat is paused from busy-chat overlap, and show the reason and recovery action on the schedule. Explain explicit model-account pins that are turned off for allocation instead of presenting them as temporary quota waits. Reclassification of an existing capacity waiter appends a new, deduplicated status event without changing earlier context, resuming paused work, or replacing an account pin.
- b5a790a: A turn waiting for Claude subscription capacity resumes when Anthropic resets a limit early: the waiter re-reads the account's usage on a bounded schedule (at most every 30 minutes per connection) instead of sleeping until the stored reset. It resumes only when the reading reports every limit the refusal's own headers named below the limit; a refusal with an unrecognized or missing limit, or without usage headers, still waits for its stored reset.

## 2.0.1

## 2.0.0

### Minor Changes

- ab3306a: Organizations can set model-account settings once and lock them for every workspace: rotation, cross-provider failover and its fallback order, whether personal accounts are allowed, and personal fallback. A shared workspace's administrators can override any setting the organization has not locked, and a locked setting cannot be overridden by anyone (enforced in the database; locking clears existing workspace overrides). New routes `GET/PATCH /v1/organizations/:organizationId/model-account-settings`, `GET /v1/organizations/:organizationId/model-account-settings/overview` and `GET/PATCH /v1/workspaces/:workspaceId/model-account-settings` (SDK `getOrganizationModelAccountSettings`, `updateOrganizationModelAccountSettings`, `getModelAccountSettingsOverview`, `getWorkspaceModelAccountSettings`, `updateWorkspaceModelAccountSettings`) report each effective value with its source: the organization, the workspace, or locked by the organization. Migration 0724 is rolling and changes no existing effective setting.

  Models settings now edit exact model fallback order, per-provider rotation and their organization locks, support workspace inheritance resets, and paginate the effective-settings overview with per-entry sources. A separate personal preference requires the person's opt-in; organization permission never opts them in, and they can withdraw a prior opt-in even while use is disallowed.

### Patch Changes

- 69a3f42: Prepare Claude subscription chat turns for the shared subscription core. A Claude turn reads its provider route once: without the Claude cutover it runs exactly as before; during maintenance it fails with typed copy; on the core it is placed, leased and funded like the other subscriptions, every model, web-search continuation and session-title request is reserved and settled before and after it goes out, an unknown outcome is never replayed, and an unauthorized response is retried at most once, on the same account, after one forced refresh. On the core, workspace model policy must allow a workspace-scoped Claude model under both its own and the organization's provider identity. Nothing changes today: no organization has the Claude cutover, so Claude, SuperGrok and Codex behave exactly as before.
- 851cbdc: Protect Codex extra credits by default, add revocable per-account spending consent with included-allowance-first rotation, and allow organization accounts to pause without disconnecting. Preserve unknown balances as null in usage responses.
- 0001298: Add provider-neutral subscription lease and placement repository APIs, and tighten source-assignment model eligibility.
- a9f5b24: Add provider-neutral inference-source modes for automatic, workspace-only, and
  organization-only account selection. Keep workspace and organization source
  membership and authorization policy separate on a canonical shared connection,
  while retaining the legacy `useOrganizationAccounts` setting as a compatible
  projection. Update the SQL settings resolver so mixed legacy/new settings
  resolve identically in PostgreSQL and TypeScript.
- 340472b: Sessions on the shared subscription core keep their account while the provider's prompt cache is warm. A session moves only when its account can no longer serve it, its model changes or a pin changes, or once it has been idle longer than the cache lifetime the provider's adapter declares. Warmth is no longer carried to an account the session has never used, and parallel placements of one session agree on one account.
- df83216: Let the shared subscription runtime manage API-key connections the same way as subscription connections. Each provider on the shared core now records which kind of connection it uses, and the shared routines, writers and placement read that instead of assuming a subscription, so a future API-key connector (such as OpenRouter or Vercel AI Gateway) needs only its own adapter and registration. A shared settlement step now records an upstream refusal the same way for every provider, with per-provider fallback times when the upstream gives no reset. No provider, table or route is added, and Codex behaves exactly as before. A conformance suite now runs the same placement, lease, request, failover, health and wait tests for Codex and for a test-only API-key connector.
- 733f01d: Claude account usage, model readiness and organization custom-model admission can now run on the shared subscription core, the same runtime Codex uses, once a deployment records the Claude cutover. Until then every Claude and Codex route, model listing and admission answers exactly as before. Usage decoding can now receive the models a connection serves.
- 4d5934e: Add `@opengeni/subscriptions`, the pure policy layer of the shared subscription
  core: contract types, effective settings with workspace overrides and locks,
  eligibility, placement (explicit choice, cache-aware stickiness, re-selection
  points, primary-first and spread ranking, personal fallback, failover order,
  explained waits and explicit failures), cache coldness, the shared quota model
  and provider adapter interface types. It has no database, provider SDK or
  network dependency and is not yet used for placement. The independent reference
  model of the contract ships as `@opengeni/subscriptions/reference`, and
  conformance tests compare every decision with it.
- 43f9b03: Run the shared subscription runtime as one provider-neutral implementation. Placement, leases, credential loading and refresh, health, request reservation and waiter cleanup now live in shared modules that take the provider as data, and Codex plugs in through a small adapter. Codex behaves exactly as before and every existing function keeps its name. A check fails if a shared module names a provider or branches on one.
- 41e4795: The subscription placement policy can derive a default cross-provider fallback order from model tiers. A model may declare an optional tier (`frontier`, `standard` or `fast`), and provider adapters gain an optional `modelTier` member. When the settings name no fallback entry for the preferred model and cross-provider failover is on, the candidates are the models of other providers with the same tier, never a higher or a lower one; an explicit entry, including an empty list, still wins, and the new `hasFallbackOrderEntry` tells a missing entry from an empty one. Nothing changes today: no adapter declares a tier yet, and the core's placement keeps cross-provider failover off.
- fe01a43: Make newly connected personal accounts usable automatically in their owner's Personal workspace while preserving permission and accepted-authority checks. Include unknown quota in normal rotation. Persist generation-fenced Codex model catalogs so allocation, waiter recovery and extra-credit admission use the same account capabilities, including retained accepted models. Correct credit-refusal retry deadlines and extend independent policy verification.
