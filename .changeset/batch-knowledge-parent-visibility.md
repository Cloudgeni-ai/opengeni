---
"@opengeni/db": patch
---

Evaluate distinct collection-parent visibility in one per-read batch instead of repeating the same recursive check for every collection member. Preserve access filtering before ranking and pagination, without retaining authority between reads.
