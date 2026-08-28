---
"@opengeni/api-router": patch
---

Close authorization-revoked SSE responses cleanly so HTTP/1 clients release stale connections without receiving any post-revocation frame.
