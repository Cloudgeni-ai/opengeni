---
"@opengeni/db": patch
---

Retire the removed provider pools' capacity-waiter, credential, lease and settings tables and the old Variable Set tables after the compatible predecessor release. Remove their obsolete routines and subscription session columns, preserving current subscription connections, shared capacity waits, Rig and Connected Machine authority, accepted execution records and historical lifecycle-backfill inputs. Refuse contraction while any old secret values or personal Variable Set resources remain.
