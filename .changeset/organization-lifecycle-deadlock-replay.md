---
"@opengeni/db": patch
---

Replay an organization membership `accept`/`suspend`/`offboard` transaction a bounded number of times after a PostgreSQL deadlock abort. Replay is exact rather than approximate: the whole lifecycle command runs in one transaction keyed by its caller-supplied operation id plus its CAS revisions, and a deadlock abort rolls back every durable effect, so re-running the identical command either applies it once or observes the newer authoritative state. `updateOrganizationMember()` and `acceptOrganizationInvitation()` are wrapped because they are exactly the lifecycle commands that acquire workspace rows and can therefore be inside a cycle at all. `40001` is still surfaced unchanged as the authoritative stale-revision conflict.

This is a caller-side safety net, not a lock-order fix: migration `0299_organization_membership_lock_order.sql` removes the organization/workspace lock-order inversion in SQL, and its parallel-load probe reads `pg_stat_database.deadlocks` directly so this replay cannot mask a regression. The `0263` lifecycle test correspondingly no longer assumes a particular deadlock victim - if the concurrent visibility transition is the one aborted it is replayed once, after which the committed offboard makes its `42501` denial deterministic.
