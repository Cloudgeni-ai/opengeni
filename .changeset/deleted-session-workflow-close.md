---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Close session workflows after a verified worker-scoped deletion instead of polling forever. Preserve unavailable/RLS-hidden observations and legacy Temporal replay, and let idle/failure settlement finish harmlessly when its session was deleted.
