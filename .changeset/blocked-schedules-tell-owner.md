---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Schedules no longer stay stuck without anyone knowing. When no later run can start until a person acts (its chat is paused or gone, a pinned account or machine is unavailable, or the run is refused for good), the schedule pauses itself and its owner gets one inbox notice saying why and what would unblock it. When runs keep failing or being skipped for a reason that may clear by itself, the owner is told once after three in a row. The notice goes away when a run succeeds or the schedule is resumed, paused or deleted, and the schedule page and API show the current blocker.
