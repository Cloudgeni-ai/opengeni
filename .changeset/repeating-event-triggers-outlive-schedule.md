---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Repeating event triggers keep an automation running after its schedule's last run: a spent one-time date or an ended interval no longer pauses an automation that still listens for events (migration 0951). A blocked run's owner notice now says whether more runs follow from the automation's triggers too, so a finished run-once automation no longer claims it keeps trying. Blocker review facts carry the automation's event policy as `task.events`.
