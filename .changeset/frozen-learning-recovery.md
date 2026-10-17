---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Preserve an accepted turn's Personal Knowledge scope when its chat is shared, including subscription failover and Retry. Keep its existing snapshot and owner authority, apply current settings to new turns, and explain genuinely incompatible scope changes without reopening the same failed turn.
