---
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
---

Give durable worker recovery sole ownership of provider retries, add bounded backoff jitter, preserve nested HTTP error classification, and observe recovery outcomes across response and compaction attempts.
