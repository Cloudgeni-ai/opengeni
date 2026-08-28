---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Shorten finite browser HTTP/1 event batches, prioritize ordinary API reads before reconnecting, and explicitly retire each completed transport so orphaned native requests cannot consume connection-pool capacity across tabs and account changes.
