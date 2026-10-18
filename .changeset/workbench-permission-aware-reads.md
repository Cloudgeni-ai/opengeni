---
"@opengeni/core": patch
---

Release the workbench correction for permission-aware optional reads: keep published Knowledge available to readers without requesting management-only pending entries, and discover rigs and Connected Machines only with their existing workspace read permissions. Preserve authorized errors and invalidate stale results when authority changes. No API permission or runtime authorization changes.
