---
"@opengeni/db": patch
"@opengeni/react": patch
---

Repair workspace control revisions behind their retained event frontier, preventing historical control replay on each fresh browser load. Reject subsequent revision rollback without altering pause state, timers, or historical events. Stop refreshing last-started model metadata for unrelated control changes.
