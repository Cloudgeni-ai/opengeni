---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Give session-message search a dedicated bounded HTTP metric label so its request latency and failures can be distinguished from unknown routes without recording search text or workspace IDs.

The stock web app debounces committed search queries, keeps partial results on transient failures, and resumes failed scans from their last successful continuation instead of discarding progress. Authorization failures still clear retained content.

Reduce long-message search database work by reusing the already-authorized event identity and scoped transaction, and coalescing adjacent scalar windows within the existing per-request budget. Literal Unicode matching, lossless offsets, live visibility checks, and ordinary conversation slice bounds are preserved.