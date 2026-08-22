---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Add the first-party `goal_wait` MCP tool and a durable goal continuation hold.
An orchestrator whose active goal depends on child sessions or an external
event records a bounded hold (reason plus mandatory deadline, at most 7 days)
with a `goal.held` timeline fact instead of busy-polling. The continuation
materializer returns `held` while the declaring turn is still the latest
finished turn and the deadline is ahead: it never consumes the goal wake
revision and re-arms a delayed workflow wake at the deadline on every idle
evaluation. Pending machine input wins with `queue`, and any newer finished
turn, a passed deadline, or a human/API/agent goal mutation clears the hold.
The goal projection reports a current hold as `blocked` / `held_for_input`
with `nextAttemptAt` at the deadline (rolling migration 0317).
