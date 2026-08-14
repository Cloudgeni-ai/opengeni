---
"@opengeni/xai-subscription": patch
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

Close terminal SuperGrok SSE streams deterministically; abort any accepted stream after a configurable interval without a complete valid event; and expose metadata-only durable lifecycle audits, bounded metrics, dashboard panels, and timeout alerting without replaying partial work.
