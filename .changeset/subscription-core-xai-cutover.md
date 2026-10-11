---
"@opengeni/db": patch
---

SuperGrok subscriptions move onto the shared subscription core in one drained maintenance migration (0717). Every organization, workspace and personal SuperGrok account becomes a shared-core connection with one readable secret copy; pins, rotation settings, quota, live leases, waiting turns and their pending wakes, in-flight videos and the accepted authority of queued, scheduled and inbox work carry over with exact parity, and any mismatch aborts the migration with nothing changed. User-scoped accounts become their owner's personal connections, and the legacy SuperGrok tables become read-only. A binary that includes 0717 refuses to start until the cutover has committed. Steer and Cancel now end a waiting turn's shared-core wait for every provider.
