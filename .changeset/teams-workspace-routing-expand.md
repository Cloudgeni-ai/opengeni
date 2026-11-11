---
"@opengeni/db": patch
"@opengeni/config": patch
---

Groundwork for Teams workspace routing, off by default. Migration 1361 adds where an organization lets its Teams connection start work (`teams_bot_installations.reach_*`: every workspace by default, or selected ones, plus Personal workspaces), the agent a 1:1 route runs as (`teams_bot_routes.agent_id`), each linked person's chosen workspace and agent (`teams_bot_chat_choices`) and the switch cards they were shown (`teams_bot_route_prompts`, `teams_bot_route_prompt_options`). Every new target column has a same-account CHECK and composite foreign keys, and the new tables use workspace row-level security. `enqueueTeamsMessage` accepts an agent and a caller-supplied live authority check for a 1:1 route's workspace. The new `OPENGENI_TEAMS_WORKSPACE_ROUTING_ENABLED` setting (off) is not read yet; nothing changes until the API uses it.
