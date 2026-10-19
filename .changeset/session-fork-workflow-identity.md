---
"@opengeni/db": patch
---

A forked chat now gets its own workflow identity, the same as every newly created chat, so its agent can wait for input and be woken on schedule instead of failing with "has no Temporal workflow identity". Existing forks without one are repaired by the migration.
