---
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

A definitively lost managed Modal sandbox no longer dead-ends its sessions. Shared sandbox groups (a parent with its children) now get the automatic checkpoint fallback, and every member receives the durable filesystem-discontinuity warning. When no checkpoint can be restored automatically (no archive, an unverified or legacy archive, an invalid artifact, or a definitive integrity failure of the selected checkpoint), the whole quiescent group continues on a new empty workspace after a separate audited decision that warns every member the previous files are not available. Loss must be proven by a loss transition (a failed replacement box never counts), the empty workspace waits until the lost box is past its hard provider lifetime, other restore failures retry the checkpoint with backoff and then wait for an operator, and a complete archive is never bypassed. Ambiguous provider states and live writers in any member still block, unknown command outcomes are never replayed, and the lost archive evidence is kept. Sessions stuck before this release recover on their next turn or Retry. The recovery projection adds `automaticLane` (`checkpoint` or `fresh_workspace`), and the failed-session banner says what Retry will do. Rolling migration 0547 requires warning protocol v3 to claim a session with an empty-workspace receipt.
