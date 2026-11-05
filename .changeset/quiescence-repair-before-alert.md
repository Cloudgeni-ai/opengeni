---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A recovering session whose interrupted attempt lost its quiescence receipt is now re-woken by the workflow-wake reaper two minutes after its last delivered wake instead of ten (migration 1260), so it recovers about four minutes after the close. The ten-minute wait coincided with `OpenGeniSessionRecoveryBacklogStale` (ten minutes past due), so a normal self-repair paged. The windows are exported as `QUIESCENCE_REPAIR_CLOSE_GRACE_SECONDS` and `QUIESCENCE_REPAIR_WAKE_QUIET_SECONDS`, and a test keeps the alert clearly longer than the worst-case repair.
