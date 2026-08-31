---
"@opengeni/api-router": patch
---

Bound Connected Machine event backlogs per exact runner. Separate connections now ingest with bounded concurrency, while consecutive queued heartbeats collapse to the newest sample without reordering lifecycle events.