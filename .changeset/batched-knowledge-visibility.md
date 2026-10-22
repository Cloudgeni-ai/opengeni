---
"@opengeni/db": patch
---

Batch Knowledge evidence visibility checks within each read and exclude keyword nonmatches before traversing their evidence graphs. Search ordering, pagination, access predicates and agent-attempt locks remain unchanged; no authority decisions are cached between reads.
