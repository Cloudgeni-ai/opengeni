---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/events": patch
---

Distribute machine state ingestion across API replicas instead of repeating every heartbeat and Hello write in every replica. Renew the exact runner lease and return its accepted metadata in one database statement, preserving independent optional inventory and metrics processing.
