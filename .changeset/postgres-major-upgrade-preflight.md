---
"@opengeni/db": patch
---

In-place PostgreSQL major upgrades no longer fail on the session tenancy fence registry, which stored its schema as a `regnamespace` column that `pg_upgrade` refuses. The registry now records the schema by name. The embedded-Postgres Helm upgrade also runs `pg_upgrade --check` against a schema-only copy of the running databases in a pre-upgrade hook, so an incompatible schema fails the release before the server is stopped.
