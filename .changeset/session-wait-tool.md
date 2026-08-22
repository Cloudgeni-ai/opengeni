---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/runtime": patch
---

Add the blocking first-party `session_wait` MCP tool so an agent can wait for new durable events on child or peer sessions, or for its own pending machine input, in one bounded call instead of sleeping and polling `session_events`/`session_get`/`sessions_list`.
