---
"@opengeni/db": patch
"@opengeni/config": patch
---

Direct database connections now use named prepared statements. Before, every parameterized query was sent unprepared, so it cost two round trips (postgres-js waits for a Describe reply before it can bind) and Postgres parsed and planned it again each time. Pools now prepare by default, except when the URL targets port 6432 (PgBouncer, including Azure Flexible Server's built-in pooler). Set `OPENGENI_DATABASE_PREPARED_STATEMENTS=false` for any other transaction-pooling proxy.
