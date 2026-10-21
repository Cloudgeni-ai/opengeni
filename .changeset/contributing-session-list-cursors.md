---
"@opengeni/db": patch
---

Read session-list attention cursors only for nodes contributing to the requested totals, avoiding visibility probes for discarded archived and pinned trees while retaining row-level security.
