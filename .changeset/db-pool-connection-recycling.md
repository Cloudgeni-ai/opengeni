---
"@opengeni/db": patch
"@opengeni/config": patch
---

Database pools close idle connections after 30 seconds again, instead of five minutes, and recycle every connection after at most ten minutes (450 to 600 seconds, jittered per connection). Each PostgreSQL backend keeps its catalog cache and prepared plans until its connection closes, so long-lived idle and busy connections grew to 65-95 MB each and ran a 32 GiB staging server out of memory. Set `OPENGENI_DATABASE_POOL_IDLE_TIMEOUT_SECONDS` and `OPENGENI_DATABASE_POOL_MAX_LIFETIME_SECONDS` to tune this for the API, worker and editable-artifact service pools; `0` turns a timer off, and values above 2,147,483 seconds are rejected. `createDb` takes the same values as `idleTimeoutSeconds` and `maxLifetimeSeconds`.
