---
"@opengeni/codex": patch
---

A Codex response whose connection breaks mid-stream (a reset HTTP body or a WebSocket that closes before the response finishes) now fails as the same typed interrupted stream as one that ends without a terminal event, so the turn recovers instead of failing.
