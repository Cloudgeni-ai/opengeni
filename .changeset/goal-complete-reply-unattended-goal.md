---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
---

An agent can now finish a goal and answer in one step: `goal_complete` takes an optional `reply`, and once the completion succeeds that reply ends the turn as its final answer, shown exactly as written. A session created through the API with `unattended: true` and a first message now gets a goal to complete that message unless the request names a goal, so it keeps working until the agent completes or pauses it; pass `goal: null` to create it without one. A keyed retry of such an unattended create now returns the original session instead of a conflict. The goal tools' descriptions are shorter.
