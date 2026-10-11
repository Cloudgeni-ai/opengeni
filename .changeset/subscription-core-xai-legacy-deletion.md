---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Remove the legacy SuperGrok subscription runtime now that SuperGrok runs only on the shared subscription core. The old SuperGrok account repository, its waiters, leases, pins, quota refresh, organization surface, API authorization helper, legacy video token envelope and shadow comparison are deleted; a SuperGrok request that does not reach the shared core fails closed, as it does during maintenance. The legacy tables stay read-only. Claude is unchanged. Rolling change; no migration.
