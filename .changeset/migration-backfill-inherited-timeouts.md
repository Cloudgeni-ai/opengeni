---
"@opengeni/db": patch
---

Restore the migration connection's inherited statement and lock timeouts after each batched backfill, including failure or query cancellation, instead of resetting them to zero. Later migrations, including concurrent index builds, retain the operator-configured statement deadline. Historical migration SQL and per-batch timeout directives remain unchanged; no new production timeout is introduced.
