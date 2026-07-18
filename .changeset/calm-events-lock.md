---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Use one canonical lock order for session-event persistence and retry only idempotent database transactions after deadlock or serialization failures.