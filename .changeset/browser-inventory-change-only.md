---
"@opengeni/db": patch
---

Avoid rewriting and locking unchanged attached-browser profiles on each inventory heartbeat. Store liveness once per enrollment while preserving per-profile last-seen timestamps and serialized material changes.
