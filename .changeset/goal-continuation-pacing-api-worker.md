---
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

The agent-facing `goal_set` MCP tool no longer accepts `maxAutoContinuations` (the ceiling stays on `CreateSessionRequest.goal` and scheduled tasks), and the operator PATCH resume emits `goal.resumed{reason:"api"}`. The worker passes the configured idle-backoff policy to the goal materializer and treats a `deferred` result like `held`: the workflow closes and the delayed wake-outbox row (or any new input) restarts it, with no Temporal timer.
