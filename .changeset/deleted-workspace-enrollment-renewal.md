---
"@opengeni/db": patch
---

Treat enrollment lookups in deleted workspaces as missing grants so credential renewal returns the existing reconnect-required response instead of an internal error. Preserve genuine database and tenant-scope failures.
