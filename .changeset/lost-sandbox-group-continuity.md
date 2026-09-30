---
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

A definitively lost managed Modal sandbox no longer dead-ends its sessions. Shared sandbox groups (a parent with its children) now get the automatic checkpoint fallback, and every member receives the durable filesystem-discontinuity warning. When no usable checkpoint survives (no archive, an unverified or legacy archive, an invalid artifact, or a failed system restore), the whole quiescent group continues on a new empty workspace after a separate audited decision that warns every member the previous files are gone. Ambiguous provider states and live writers in any member still block, unknown command outcomes are never replayed, and the lost archive evidence is kept. Sessions stuck before this release recover on their next turn or Retry. The recovery projection adds `automaticLane` (`checkpoint` or `fresh_workspace`), and the failed-session banner says what Retry will do. Rolling migration 0547 requires warning protocol v3 to claim a session with an empty-workspace receipt.
