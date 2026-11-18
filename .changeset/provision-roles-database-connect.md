---
"@opengeni/db": patch
---

`db:provision-roles` now grants `CONNECT` on the Opengeni database to the runtime app role and the host-export role, as it already did for the artifact roles. Installs on a PostgreSQL host that revokes `CONNECT` from `PUBLIC` no longer fail `db:assert-runtime-posture` with "permission denied for database".
