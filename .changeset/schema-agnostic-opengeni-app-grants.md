---
"@opengeni/db": patch
---

Repair embedded-schema database migrations by re-granting `opengeni_app` table and sequence privileges in the active schema and setting schema-scoped default privileges for future objects.
