---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Bound session stream replay pages by bytes before transferring event payloads. Stop interactive page sizing at the byte target and preserve complete oversized events, durable cursors, reconnect replay and tenant isolation.
