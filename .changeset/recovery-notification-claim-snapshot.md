---
"@opengeni/db": patch
---

Prevent concurrent organization recovery dispatchers from claiming the same notification from an old statement snapshot. Preserve immutable delivery evidence and require READ COMMITTED claim transactions.
