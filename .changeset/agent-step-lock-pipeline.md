---
"@opengeni/db": patch
---

Reduce inter-step database waits by submitting the existing session write-fence statements in canonical order on their pinned transaction connection, preserving lock order, fresh snapshots and control budgets.
