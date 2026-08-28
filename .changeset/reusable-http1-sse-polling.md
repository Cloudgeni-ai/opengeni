---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Keep finite browser HTTP/1 event batches on reusable connections and shorten their bounded cycle so ordinary API reads retain connection-pool headroom across tabs and account changes.
