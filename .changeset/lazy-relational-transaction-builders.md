---
"@opengeni/db": minor
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Remove unused Drizzle relational-schema registration from `createDb`, avoiding hundreds of query-builder allocations on every transaction. SQL, row-level security, and commit boundaries are unchanged.

Breaking: the exported `Database` port and its transaction callbacks no longer expose `db.query.<table>`. Use explicit-table queries instead, for example `db.select().from(schema.sessions).where(eq(schema.sessions.id, id))`. Hosts may still inject their own schema-configured Drizzle handles and use relational queries through their original handle; Opengeni's structural port only needs explicit-table builders.
