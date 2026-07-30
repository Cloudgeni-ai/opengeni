---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Resolve session existence and the latest workspace capture in one RLS-scoped query so capture metadata requests avoid loading the full session projection.
