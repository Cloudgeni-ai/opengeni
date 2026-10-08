# `@opengeni/subscriptions`

The pure policy layer of OpenGeni's shared subscription core. It decides which
subscription account (Codex, Claude, SuperGrok, or an API-key connection) a
session's turn runs on, and why it waits otherwise. It has no database,
provider SDK or network dependency, no clock and no randomness: every input
is passed in, and every function is deterministic.

The package owns:

- contract types: connections and scopes, settings with workspace overrides
  and locks, session bindings, the shared quota model, placement decisions,
  switch, wait and fail reasons;
- `effectiveSettings`: organization defaults, unlocked workspace overrides and
  the source of every value;
- eligibility: authorization (scope, personal ownership, frozen personal
  authority, provider switches) separated from serviceability (health,
  allocator, entitlement, access policy, cooldowns, capacity);
- `decidePlacement`: explicit choice, cache-aware stickiness, re-selection
  points, failover candidate order, primary-first and spread ranking,
  personal fallback, explicit failures and explained waits;
- cache coldness, reasoning-level mapping and the spread hash; and
- the provider adapter interface types.

Authority stays in SQL: a bug here can at worst pick a worse eligible account,
never a forbidden one. Persistence, leases, waiters and provider calls live in
`@opengeni/db`, the worker and the provider adapters.

The behaviour contract is [`docs/subscription-accounts.md`](../../docs/subscription-accounts.md)
and the design is
[`docs/design/subscription-core-2026-10-07.md`](../../docs/design/subscription-core-2026-10-07.md).
The independent reference model of the contract ships separately as
`@opengeni/subscriptions/reference`, with a bridge that lets its
`checkDecision` judge production decisions; placement never imports it. It is
there so the worker's shadow comparison can check decisions in production.
Conformance tests compare every decision with the reference model over
generated reference worlds, generated production-only inputs (provider
switches, personal authority, compaction locks, quota shapes) and scripted
scenarios.

An ownerless service session is represented with a null owner. It may use
eligible shared connections, but never people-scoped connections or personal
connections, and personal fallback is unavailable because there is no human
owner whose authority could authorize it.
