---
"@opengeni/core": patch
---

Forward the live Connected Machine transactional-write capability to one-off `run_on` operations so large writes use bounded, verified transfers. Preserve per-request authority checks, connection fencing, and legacy-agent behavior without replaying uncertain writes.
