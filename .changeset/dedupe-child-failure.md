---
"@opengeni/worker-bundle": patch
---

Reuse the failed turn identity across database and workflow child-terminal producers so one failure cannot enqueue two parent updates.
