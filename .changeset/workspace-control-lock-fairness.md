---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Make the workspace control prefix fair and bounded: `lockWorkspaceInferenceControl` takes a FIFO transaction advisory lock before the row lock so Pause/Resume cannot be starved by continuous shared claim/settlement/append traffic, Send/Steer/queued Steer/realtime sync hold the prefix shared while the target branch is active and escalate through a savepoint only for a paused branch, and request-scoped API mutations fail with a typed retryable `WorkspaceControlBusyError` (HTTP 503) instead of parking a pooled connection and snapshot when the prefix stays busy.
