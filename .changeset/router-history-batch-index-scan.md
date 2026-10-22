---
"@opengeni/db": patch
---

Keep each response-page router-history probe on its early-stopping index scan, so a long-running session's router items are not all collected before the first match.
