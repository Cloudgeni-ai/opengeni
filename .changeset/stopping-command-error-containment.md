---
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
---

Allow repeatedly unobservable, explicitly stopping managed commands to enter the existing checkpoint-before-termination recovery after owner quiescence and idle grace. Preserve running commands, all other writer fences, failed-checkpoint recovery, and real late exit proof.