---
"@opengeni/db": patch
---

Reuse the caller's tenant transaction when checking a turn's linked identity during connection authorization. Keep live revocation and permission checks while removing redundant savepoint and RLS setup statements.
