---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

Restore immutable concurrent-index migration history, stage populated-table migrations safely, and reject goal-bearing child sessions whose resulting first-party authority lacks `goals:manage`.