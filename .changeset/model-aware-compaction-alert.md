---
"@opengeni/worker-bundle": patch
---

Make context-compaction alerting follow durable model-aware starts, initialize
closed trigger metrics before their first event, and retain first-failure
visibility across startup-to-first-scrape timing.