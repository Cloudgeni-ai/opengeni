---
"@opengeni/db": patch
---

Migrations now apply to a fresh PostgreSQL 18 database. PostgreSQL 18 records column NOT NULL constraints in `pg_constraint`, which made two historical migrations fail on a new install: 0345's tenancy-fence drift check and 0598's Claude pool table copy. Both now skip those rows; databases that already ran them are unaffected.
