---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A compaction-only turn, such as the idle compaction checkpoint after a person's turn or an idle `/compact`, now runs with that person's current connection accounts, resolved the same way as other work that continues the turn. The compaction request carries the same personal and connector tools as the turn before it, so it reuses that turn's cached prompt prefix instead of missing the cache. A picked account that can no longer be used leaves its connector out, and if the accounts can't be resolved at all, the compaction still runs with only the session's shared tools.
