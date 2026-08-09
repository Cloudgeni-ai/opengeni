---
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

Keep turn-activity heartbeats and the Temporal SDK cancellation throttle at 500
milliseconds so Pause and Steer retain the full four-second physical-cancellation
budget for writer drain and receipt-gated replacement admission.
