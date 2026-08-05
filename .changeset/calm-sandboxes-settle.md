---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Prevent deadlocks between sandbox mutation settlement and retained-process promotion, retry idempotent settlement transactions after transient database conflicts, and clarify that an idle session sandbox can be restored when the next operation needs it.
