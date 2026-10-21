---
"@opengeni/db": patch
---

Evaluate the existing Knowledge scope predicate as a cached PL/pgSQL expression instead of a separate SQL query for every candidate and evidence identity. Keep all tenant, personal, temporal and legacy-scope checks, security metadata and response semantics unchanged.
