---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A forked chat runs on the same Connected Machine and working directory as the chat it was forked from, when the person forking may use that machine, so its first message no longer fails with an internal sandbox error. Someone else's personal machine is never carried over, and a personal machine still asks its owner for approval in the fork just as it does in any other chat. A chat that runs on Connected Machines but has no machine selected, on a deployment without a managed sandbox, now says so and asks for a machine instead of failing with "no agentId bound".
