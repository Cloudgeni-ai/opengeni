---
"@opengeni/db": patch
---

No behaviour change. The session event page sizing query now documents the actual PostgreSQL cause of the November 2026 slowdown (the CVE-2026-116327 leakproofness rule under row-level security), and its plan test also fails if any recursive step filters rows out of a scan.
