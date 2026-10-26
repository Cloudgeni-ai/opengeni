---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Automations that continue a chat have a new overlap choice, `overlapPolicy: "steer"`. When the automation's next run arrives while its own earlier run is still working in the chat, the run reaches that turn at its next model step, the way a person's Steer does: the step's tool calls finish, and the agent then reads the new run together with the work so far instead of waiting for the whole turn. A turn anyone else started (a person, a goal continuation, another automation) still finishes first, and a run waiting on a person's approval keeps waiting. `steer` is refused for automations whose runs each start a new chat. The automation form and detail page offer it as "Steer the current run", and the agent tools now explain every overlap choice, including that `allow_concurrent` and `buffer_one` both wait in a chat.

A turn whose steer watch had noticed a waiting Steer that was then withdrawn (or whose automation was paused) no longer has every later model request cut short; it listens again and keeps working.
