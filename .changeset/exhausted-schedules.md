---
"@opengeni/db": patch
"@opengeni/core": patch
---

Pause exhausted one-shot and bounded interval schedules after accepted runs settle, preserving Temporal catch-up semantics. Repair existing exhausted schedules and durably reconcile their Temporal state against the latest saved task.
