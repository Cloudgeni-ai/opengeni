---
"@opengeni/db": patch
---

Services recover on their own after their PostgreSQL server restarts or fails over. Connections that failed while the database was down were never returned to the pool, so once every connection had failed, all queries and readiness checks hung until the process was restarted, even after the database was back. A failed connection now reconnects like any other.
