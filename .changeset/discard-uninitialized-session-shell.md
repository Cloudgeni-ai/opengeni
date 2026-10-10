---
"@opengeni/db": patch
"@opengeni/core": patch
---

A session whose start fails before its first event or turn is now discarded instead of staying visible as a queued session that never runs. A keyed create also releases its idempotency key, so retrying with the same key starts the session normally.
