---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Automations have a new overlap choice, `overlapPolicy: "steer"`, and it is the default for new automations. When an automation that continues a chat gets its next run while its own earlier run is still working there, the run reaches that turn at its next model step, the way a person's Steer does: the step's tool calls finish, and the agent then reads the new run together with the work so far instead of waiting for the whole turn. A turn anyone else started (a person, a goal continuation, another automation) still finishes first, and the run follows it; a run waiting on a person's approval keeps waiting. Runs that each start a new chat never overlap, so the choice changes nothing for them.

Creating an automation without `overlapPolicy` now gives `steer` (previously `allow_concurrent`, or `buffer_one` for a message scheduled into a chat). Existing automations keep their stored choice. Pass `buffer_one` to keep waiting for the whole turn. The automation form offers Steer, Queue and Skip, starting on Steer; the reusable automation panel creates chat automations with the default; and the agent tools now explain every overlap choice, including that `allow_concurrent` and `buffer_one` both wait in a chat.

A turn whose steer watch had noticed a waiting Steer that was then withdrawn (or whose automation was paused) no longer has every later model request cut short; it listens again and keeps working.
