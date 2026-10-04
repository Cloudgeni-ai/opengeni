---
"@opengeni/db": patch
---

Prevent Bun PostgreSQL TLS upgrades from retaining encrypted traffic in the original TCP socket's unread queue. Preserve TLS negotiation, certificate policy, and lossless query results, with regression coverage for both driver entrypoints.