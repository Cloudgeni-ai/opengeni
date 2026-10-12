---
"@opengeni/db": patch
---

Add a read-only migration plan: `bun run db:migrate-plan` (or `bun src/migrate.ts --plan` in `@opengeni/db`, and the exported `planMigrations`) lists the shipped migrations the database has not applied, each with its declared deployment mode, and reports `requiresDrain`. An upgrade whose pending migrations are all `rolling` can run the migration job while the previous release keeps serving, so a deploy only needs to drain API and worker processes when the plan says so.
