---
"@opengeni/db": patch
---

Move the unapplied Slack delete-operation migration after the already-deployed
sandbox migration history, while accepting only the exact legacy staging
receipt for an idempotent replay.
