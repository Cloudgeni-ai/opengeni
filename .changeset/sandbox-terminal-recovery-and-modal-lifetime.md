---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

Treat native provider snapshot receipts as typed opaque artifacts instead of tar
trees; track every Modal Image in a provider-bound, crash-safe checkpoint ledger;
garbage-collect displaced and publication-losing Images; adopt only provable
legacy ownership; bind retained processes to their exact Modal namespace and
reconcile historical terminal boxes without touching successors; rotate finite
Modal boxes through the canonical checkpoint/drain/rematerialization path before
their persisted deadline without checkpointing across an active direct API
mutation; memoize terminal recovery failures; and use Modal's
documented 24-hour maximum as the default hard box lifetime. Frame confined
filesystem/Git command output at both boundaries with a fresh attempt nonce and
strict exit-status parsing so provider diagnostics, truncation, or delayed
retries cannot corrupt Modal-like `execCommand` control records. Seed shared
session-event cursors from already-loaded history so opening a large session
does not replay every historical queue event as a fresh composer-draft read.
