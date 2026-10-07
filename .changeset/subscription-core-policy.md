---
"@opengeni/subscriptions": patch
---

Add `@opengeni/subscriptions`, the pure policy layer of the shared subscription
core: contract types, effective settings with workspace overrides and locks,
eligibility, placement (explicit choice, cache-aware stickiness, re-selection
points, primary-first and spread ranking, personal fallback, failover order,
explained waits and explicit failures), cache coldness, the shared quota model
and provider adapter interface types. It has no database, provider SDK or
network dependency and is not yet used for placement. The independent reference
model of the contract ships as `@opengeni/subscriptions/reference`, and
conformance tests compare every decision with it.
