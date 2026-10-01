---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Keep streamed safety diagnostics terminal even under server-error codes, recognize bounded diagnostic-only context overflows for compaction, and retain HTTP Retry-After evidence on yielded Responses failures so long quota waits do not enter automatic recovery.