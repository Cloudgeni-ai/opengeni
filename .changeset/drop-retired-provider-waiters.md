---
"@opengeni/db": patch
---

Retire the removed provider pools' capacity-waiter, credential, lease and settings tables, the old Variable Set tables and retired resumable-transcription tables after the compatible predecessor release. Remove their obsolete routines and subscription session columns, preserving current subscription connections, shared capacity waits, Rig and Connected Machine authority, current recordings, accepted execution records, retention obligations and historical lifecycle-backfill inputs. Refuse contraction while any old secret values, personal Variable Set resources, transcription processing or unconfirmed audio-object deletions remain.
