# @opengeni/subscriptions

## 1.5.0

### Patch Changes

- 851cbdc: Protect Codex extra credits by default, add revocable per-account spending consent with included-allowance-first rotation, and allow organization accounts to pause without disconnecting. Preserve unknown balances as null in usage responses.
- 0001298: Add provider-neutral subscription lease and placement repository APIs, and tighten source-assignment model eligibility.
- a9f5b24: Add provider-neutral inference-source modes for automatic, workspace-only, and
  organization-only account selection. Keep workspace and organization source
  membership and authorization policy separate on a canonical shared connection,
  while retaining the legacy `useOrganizationAccounts` setting as a compatible
  projection. Update the SQL settings resolver so mixed legacy/new settings
  resolve identically in PostgreSQL and TypeScript.
- 4d5934e: Add `@opengeni/subscriptions`, the pure policy layer of the shared subscription
  core: contract types, effective settings with workspace overrides and locks,
  eligibility, placement (explicit choice, cache-aware stickiness, re-selection
  points, primary-first and spread ranking, personal fallback, failover order,
  explained waits and explicit failures), cache coldness, the shared quota model
  and provider adapter interface types. It has no database, provider SDK or
  network dependency and is not yet used for placement. The independent reference
  model of the contract ships as `@opengeni/subscriptions/reference`, and
  conformance tests compare every decision with it.
