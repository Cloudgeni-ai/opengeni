---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A session whose Connected Machine is offline (or whose control requests time out) no longer fails every turn before the model runs when it has repository resources. Repository Skill discovery now degrades to a short "repository skills unavailable" instruction for that run, so the agent can still answer and explain the outage; the next run discovers again. Other discovery failures still fail the turn.
