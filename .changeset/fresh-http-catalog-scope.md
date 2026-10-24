---
"@opengeni/api-router": patch
---

Reuse one fresh tenant-scoped public metadata read for the HTTP model catalog, removing redundant transaction setup without caching authorization or provider readiness.
