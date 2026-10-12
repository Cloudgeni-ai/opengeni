---
"@opengeni/db": patch
---

Export `MAINTENANCE_WORK_PROBE_ROUTINES`, the read-only maintenance work checks that the runtime posture verifies, so posture fixtures can derive the expected checks instead of pinning a copy that drifts when a check is added.
