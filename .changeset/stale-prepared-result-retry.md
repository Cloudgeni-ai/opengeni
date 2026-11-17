---
"@opengeni/db": patch
---

Adding a column during a rolling deploy no longer fails requests on pods still running the previous release. Postgres refuses a prepared `select *`, `table.*` or `returning *` statement whose row gained a column ("cached plan must not change result type", SQLSTATE 0A000); a transaction refused this way is now repeated, and the refusing connection forgets all of its prepared statements so it is refused at most once. During the 6.25.0 rollout this caused about 25 failed requests while migration 1477 added a column to `sandbox_leases`.
