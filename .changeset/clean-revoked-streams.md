---
"@opengeni/api-router": patch
---

Close authorization-revoked SSE responses cleanly and cycle browser streams with server- and browser-owned HTTP/1 lifetimes so stale or orphaned native requests cannot exhaust the shared connection pool or starve ordinary API reads.
