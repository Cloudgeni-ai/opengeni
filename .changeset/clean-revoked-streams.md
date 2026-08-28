---
"@opengeni/api-router": patch
---

Close authorization-revoked SSE responses cleanly and cycle browser streams on HTTP/1 so stale tabs cannot exhaust the shared connection pool or starve ordinary API reads.
