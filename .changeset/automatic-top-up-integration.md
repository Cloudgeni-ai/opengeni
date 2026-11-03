---
"@opengeni/api-router": patch
"@opengeni/db": minor
"@opengeni/core": patch
---

Normalize automatic top-up journal grants for legacy/custom migration owners in
an additive migration, preserving append-only intent before role reprovisioning.

Run automatic top-up reconciliation through the API lifecycle and atomically enqueue owner notifications in the shared billing outbox, preserving replay snapshots and disabled-mode recovery.
