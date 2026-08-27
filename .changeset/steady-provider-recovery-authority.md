---
"@opengeni/worker-bundle": patch
---

Preserve the exact provider retry count when an operational database outage interrupts same-turn recovery, preventing stale replacement attempts from reopening an already-consumed retry generation.
