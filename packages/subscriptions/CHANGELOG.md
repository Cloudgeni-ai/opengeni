# @opengeni/subscriptions

## 6.22.0

## 6.21.0

## 6.20.1

## 6.20.0

## 6.19.0

## 6.18.0

## 6.17.0

### Patch Changes

- 4d7c96e: The subscription usage pool no longer reports a five-hour "Observed pool exhaustion" for accounts that have no five-hour limit. Codex plans with only a weekly limit report no five-hour window, and an account at its weekly limit used to be counted in the five-hour total as nothing usable. When it was the only account in that total, the whole pool read 0 % and "runs out now", even while other accounts served normally. A complete usage reading that omits a window now marks the account as not having it. The account is listed as unknown in that window and kept out of its total and forecast. A window that no account has reports "No account has this limit.", and a usage-limit deadline that matches no reset is placed in a window the account has. A refusal of a window still counts, and refusals, response headers and incomplete providers never mark a window absent.

## 6.16.0

## 6.15.0

### Minor Changes

- 60d067d: Claude subscription usage now matches what Claude reports today. The usage refresh reads the account's limit reset grants (presenting Claude Code's CLI surface, which Claude requires for them) and, while at a limit, the at-limit reset program. `ClaudeSubscriptionUsage` gains optional `limitResets`, `wallReset`, `limits`, `extraUsage`, `surfaceWindows` and `serviceState`, and the SDK exports their types. The account page lists each grant with what it clears, resets left, expiry and whether it can be used now. `@opengeni/db` adds the adapter-level claim and claim-then-refresh helpers (idempotent request ids); Opengeni never claims a grant on its own.

  The weekly limit model responses call `seven_day_overage_included` is treated as the weekly Fable limit: it limits Fable models only and shows as "Fable week". Responses served in the slow tier or grace zone mark a connection constrained (`SubscriptionQuota.constrainedUntil`): it still serves, but placement prefers accounts with plain capacity, and busy slow-tier slots are a short rate limit rather than the weekly limit.

## 6.14.0

## 6.13.0

## 6.12.0

### Patch Changes

- 831f2ef: A subscription capacity wait now reports the reset that actually blocks, and its notification no longer promises a time that has passed. A provider quota refusal that came without a reset time got a five-hour fallback deadline even while the account's weekly allowance was spent, so the wait named that fallback, an account with extra credits was retried when it ended and refused again, and the chat stayed stuck past the time it promised. A running quota exhaustion now lasts until every usage window still spent beside it resets (`quotaExhaustionHeldByWindows`), so the wait names the earliest real reset across the eligible accounts and resumes then; a usage reading that shows the limit lifted still ends it early. The person's inbox notification for a long wait is updated in place (same key, no new alert) whenever a later check finds the wait ends later than it said, after its time passed without capacity, or that no reset time is known.

## 6.11.0

## 6.10.0

## 6.9.0

## 6.8.0

## 6.7.0

### Patch Changes

- b0736b7: Opening a chat no longer waits for a slow subscription provider's model list. When a shared ChatGPT subscription's list is more than a minute old, the client config and model picker waited for a live refresh (token renewal plus the provider's model list, up to its 5 second timeout). They now wait at most 300 ms, then use the last list observed under the same credentials (or treat the account as unknown, never unavailable) while the refresh finishes in the background and records its result. The step now has its own trace span with its outcome.

## 6.6.0

## 6.5.1

### Minor Changes

- 0f7f559: A turn uses its person's own Codex, Claude or SuperGrok subscription first, where they turned it on. In their Personal workspace it is always on; in any other workspace each person turns their own account on for the messages they send there, in shared and Only me chats alike, and it then pays before the organization's accounts. Other people's turns never use it, and turns without a signed-in person (scheduled and service turns) don't either. An account added from a shared workspace starts turned on there, and each account's page has a "Use for my messages in …" switch per workspace.

  Being turned on is a standing personal-resource grant: user-resource kind `subscription_connection` with action `subscription_connection.use`, issued with mode `always` and context `workspace_shared` in that workspace and revoked like any other grant. Acceptance freezes the account into the turn as consent restricted to that session and connection, and in shared chats the database refuses an automatic binding to a personal account without it. `issueUserResourceGrant` moves to the base and browser clients, beside `listUserResourceAuthorities` and `revokeUserResourceGrant`.

  The per-person personal-fallback opt-in and the organization's "personal fallback allowed" setting are retired: both are still stored and returned, but no longer change which account pays, and the settings page no longer shows them. Existing opt-ins are not converted, because that would widen where an account is used.

## 6.4.0

## 6.3.1

### Minor Changes

- 40b79c9: Claude subscription models no longer disappear from a workspace when the Claude accounts serving it are not managed by that workspace. The catalog, model admission and cross-provider failover now count every Claude account that serves the workspace, the same accounts placement already used, for both the `workspace-claude-subscription/` and `organization-claude-subscription/` model ids. Readers also accept the upcoming canonical `claude/<model>` ids (provider `claude-subscription`), which a later release starts writing; the two legacy ids stay accepted as aliases.

## 6.2.1

## 6.1.1

## 6.0.2

### Patch Changes

- 202e3fd: The subscription usage pools read no longer fails for heavily used organizations. It returned every usage reading and call of the last 14 days as one value, which passes Postgres's 256 MB limit at around a million of them. It now returns each window's changes, its first reading in every five-minute slot, and call totals between readings, so its size follows how often usage changes rather than how many calls ran. The forecast samples usage on five-minute slot boundaries, so it is the same from this read as from every row, apart from how a total's calls are capped when damping call-size outliers.

## 5.5.1

## 5.4.2

## 5.3.1

## 5.2.1

## 5.1.2

## 5.0.2

## 4.8.0

## 4.7.2

## 4.7.1

## 4.7.0

## 4.6.1

## 4.5.0

### Patch Changes

- acbf24e: Withhold pooled subscription capacity while an account's other main limit is exhausted, and report the next usable reset when the pool is already exhausted.

## 4.4.1

### Minor Changes

- 84b1a18: Every subscription account now has exactly one owner: the organization, one workspace, or one person, and it is used wherever it reaches and nowhere else. The per-workspace split between a workspace's own copy of an account and the organization's copy, the preference that chose between them, and "Set aside" are gone; each account has one on/off switch. A migration keeps everyone's access exactly as it was.

  The organization's account lists now include `reach` (who each account reaches), and the organization's Models page lists every account once, grouped by provider, with its owner and a summary of how many are on and how many need reconnecting. Accounts that are turned off fold away when a provider has several, and the page no longer reads every workspace's accounts or each account's access one by one.

## 4.3.1

### Minor Changes

- 9976132: Add pooled weekly subscription utilization, estimated plan-size weighting and reset-aware forecasts with one total remaining bar. Retain observed limit history; organization pools cover organization accounts and workspace pools cover all visible accounts available to that workspace, using each account's total usage. Show five-hour limits only when blocking an account; keep individual account details in the account list.

## 4.2.0

### Patch Changes

- 93e20fe: Redeeming a Codex rate-limit reset credit now restarts chats waiting for that account within seconds. The stored usage windows read before the reset are invalidated along with the stored exhaustion deadline, so a woken waiter places on the account instead of waiting again until the old weekly reset; it no longer depends on a later live usage read.

## 4.1.3

## 4.1.1

## 4.0.4

## 3.4.0

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
