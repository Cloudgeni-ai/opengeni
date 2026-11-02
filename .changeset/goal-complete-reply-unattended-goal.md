---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": minor
---

An agent can now finish a goal and answer in one step: `goal_complete` takes an optional `reply`, and once the completion succeeds that reply ends the turn as its final answer, shown exactly as written. A session created through the API with `unattended: true` and a first message now gets a goal to complete that message unless the request names a goal. Like any goal, it makes the run continue when the agent stops without completing or pausing it, within the deployment's continuation and budget limits, so such runs can take more turns than before; pass `goal: null` to create one without a goal, as before. A keyed retry of such an unattended create now returns the original session instead of a conflict. A task that seems infeasible, missing data or a result the agent cannot verify is no longer by itself a reason to pause a goal: the agent tries the plausible alternatives first and, if it still pauses, names them in the rationale. The goal tools' and `wait_for_input`'s descriptions are shorter.
