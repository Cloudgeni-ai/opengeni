---
"@opengeni/db": patch
---

The statistics-cadence migration for the sessions and session event cursor tables now applies to whichever schema the database is installed in. It previously named the public schema, so installs into a dedicated schema failed to migrate.
