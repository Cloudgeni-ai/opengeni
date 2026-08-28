---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Return browser HTTP/1 event streams as capped, known-length batches so multiple tabs cannot retain ambiguous streaming requests and starve ordinary API reads.
