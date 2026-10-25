---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Long screenshot-heavy sessions no longer die with `active_history_too_large`. Automatic compaction now also runs when the stored active history reaches 60% of its materialization guard, or when a request reaches 60% of the provider's per-request image limit. A session that is already over the guard compacts from a bounded view, built in PostgreSQL with the oldest inline images left out, and continues. The remaining error, for an item too large even for that view, now says to clear the context or start a new session. New exports: `readActiveSessionHistory`, footprint and pressure helpers, `providerRequestImageLimit` and `countModelInputImages`.
