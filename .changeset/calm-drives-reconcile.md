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
observation in one scan generation as a durable monotonic floor. Fence item
version/metadata writes plus checkpoint and terminal cursor settlement to the
exact lease, initiating subject, scan, checkpoint generation, and accepted
floor, so a lost full-page checkpoint cannot replay version 8 as version 7.
