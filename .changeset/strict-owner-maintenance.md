---
"@opengeni/db": patch
"@opengeni/testing": patch
---

Restore background maintenance when the migration owner cannot bypass FORCE RLS.
Keep due checks read-only using transactionally maintained private predicate
indexes, and admit fixed claim/reaper bodies with narrowly scoped private
capabilities. Exercise real PostgreSQL maintenance lifecycles with a
NOSUPERUSER/NOBYPASSRLS migration owner. Migrations 0848–0849 require a maintenance
rollout because the runtime helper/grant posture contract changes.
