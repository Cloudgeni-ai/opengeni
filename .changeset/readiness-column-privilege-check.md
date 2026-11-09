---
"@opengeni/db": patch
---

The database readiness check is cheaper. Its table inventory now finds column-level grants by checking only the columns that have their own privileges, instead of calling `has_any_column_privilege`, which reads every column of every table into a fresh connection's catalog cache. It reports the same privileges as before. Concurrent API readiness probes now share one outstanding posture inspection, as worker probes already do, so a slow database no longer ties up one pooled connection per probe. Every probe that starts after an inspection finishes still runs a full, live inspection.
