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
across delta, continuation, and full-repair checkpoints. Carry bounded
per-object revision floors across delta-to-full and checkpointed full scans so
older or equal Drive revisions cannot regress accepted metadata/current-version
state, fail closed on conflicting fallback identities, and keep the first
observation in one scan generation stable under replay.
