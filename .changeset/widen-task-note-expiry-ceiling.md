---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
---

Widen the task-note expiry ceiling from 30 to 90 days. Task notes are pure agent-to-agent coordination within one root session tree; resuming a paused root session/task tree after a longer gap previously lost all coordination notes silently. `TASK_NOTE_MAX_LIFETIME_DAYS` is now the single source of truth, referenced by the application-layer bound checks and `remember`'s evidence note instead of a hardcoded literal. Fully backward compatible: every existing row and every caller supplying 1-30 days keeps working unchanged.
