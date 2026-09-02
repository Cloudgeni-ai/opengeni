---
"@opengeni/worker-bundle": patch
---

Make context-compaction alerting follow durable model-aware starts, initialize
closed trigger metrics before their first event, and retain exact-attempt
pending visibility across concurrency, terminal skips, and worker restarts.
