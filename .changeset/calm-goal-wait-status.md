---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Prevent an active-goal status update from immediately spawning a continuation that repeats the same unchanged external wait. Status turns now establish an available goal hold when progress is genuinely blocked, while continuation turns avoid restating an already-reported wait before calling `goal_wait`.