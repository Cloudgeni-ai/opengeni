---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Deliver finite browser HTTP/1 event batches as ordinary vendor-typed requests, explicitly retire their connections, and shorten their bounded cycle so orphaned document streams cannot consume Chromium's shared SSE pool or starve ordinary API reads across tabs and account changes.
