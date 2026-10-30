---
"@opengeni/db": patch
---

Retire the removed provider pools' capacity-waiter, credential, lease and settings tables after the compatible predecessor release. Remove their obsolete routines and session columns, preserving current subscription connections, shared capacity waits, accepted authority and historical lifecycle-backfill inputs.
