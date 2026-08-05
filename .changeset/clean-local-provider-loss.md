---
"@opengeni/core": patch
"@opengeni/runtime": patch
---

Treat the SDK's exact UnixLocal missing-workspace proof as provider loss so stale local leases can recover or drain cleanly, and expose ordinary sandbox-operation availability separately from live attach/swap readiness.
