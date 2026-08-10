---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Add durable Google Drive Changes cursors, Shared Drive-aware delta draining,
bounded full reconciliation, cursor-invalid repair, and a default-off
Workspace Events wake seam. Normalize My Drive's root alias before ancestry
checks and preserve cumulative item, provider-request, and elapsed budgets
across delta, continuation, and full-repair checkpoints.
