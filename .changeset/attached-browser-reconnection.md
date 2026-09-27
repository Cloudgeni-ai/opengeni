---
"@opengeni/contracts": patch
---

Accept native browser bridge base64url generation IDs unchanged, including leading hyphens and underscores, so healthy Chrome profiles remain discoverable. Repair extension reconnection after handshake timeout or rejected readiness, and ignore stale port callbacks.
