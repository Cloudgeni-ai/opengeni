---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Keep over-limit viewer-only sandboxes drained until a fresh serialized balance
or monthly-cap evaluation clears a durable workspace admission gate. Viewer
reattach can no longer re-arm a draining box or spawn a cold successor, while a
turn-held sandbox remains viewable.
