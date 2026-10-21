---
"@opengeni/db": patch
---

Add cumulative pre, maintenance and post migration phases, read-only phase plans,
and a versioned completion receipt. Limit pre to posture-inert rolling work so
the old fleet's continuous readiness checks remain valid. Defer the eligible rolling suffix until after
traffic returns, with validated post-release markers for unique concurrent
indexes and batched backfills and a pre-release index opt-out. The default runner
continues applying every pending migration.
