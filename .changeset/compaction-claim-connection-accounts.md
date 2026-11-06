---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A compaction-only turn, such as the idle compaction checkpoint after a person's turn or an idle `/compact`, now runs with that person's current connection accounts, resolved the same way as other work that continues the turn. The compaction request normally carries the same account-routed connector and personal tools (such as personal GitHub) as the turn before it, so it reuses that turn's cached prompt prefix instead of missing the cache. A picked account that can no longer be used leaves its connector out. A private chat lends only its owner's accounts, and a turn from an external link or under a credential restriction lends none. If the accounts can't be resolved at all, the compaction still runs with only the session's shared tools and the worker logs a warning.
