---
"@opengeni/api-router": minor
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": minor
---

Teams workspace routing, behind `OPENGENI_TEAMS_WORKSPACE_ROUTING_ENABLED` (off by default). When it's on, a linked person's 1:1 chat can start work in any workspace of the connecting organization they can start chats in, as in Slack:

- `switch` shows a card with their workspaces and agents. A message sent before they choose waits on the card.
- `in <Workspace>: …` sends one message elsewhere.
- `Name: …` or `+name` asks one of the organization's shared agents.
- Agent replies carry an "**Agent** · Workspace" header, and the first reply after a choice says where the chat is saved.

Organization membership, the person's authority in the target workspace and the organization's reach are read live at enqueue, admission and delivery. A choice that no longer works is refused, never served from another workspace.

With routing on:

- Linking is open to any active full member of the organization, still bound to the Teams user's Microsoft identity. The link card opens `/teams/connect`.
- Organization admins limit which workspaces Teams can reach with the same **Available in Opengeni** control as Slack, through `GET`/`PUT /v1/workspaces/:workspaceId/integrations/teams/reach` (`TeamsBot.getReach` and `setReach` in the SDK).
- `TeamsBotStatus.workspaceRouting` says whether routing is on.

Group chats and channels are unchanged.

Database: migration 1363 adds where an organization lets its Teams connection start work (`teams_bot_installations.reach_*`: every workspace by default, or selected ones, plus Personal workspaces), the agent a 1:1 route runs as (`teams_bot_routes.agent_id`), each linked person's chosen workspace and agent (`teams_bot_chat_choices`) and the switch cards they were shown (`teams_bot_route_prompts`, `teams_bot_route_prompt_options`). Every new target column has a same-account CHECK and composite foreign keys, and the new tables use workspace row-level security. Migration 1364 indexes `teams_bot_routes.agent_id` concurrently. `enqueueTeamsMessage` accepts an agent and a caller-supplied live authority check for a 1:1 route's workspace and agent, and refuses a route that names an agent without one. Disconnecting Teams removes waiting switch cards. Both migrations are rolling: the previous release ignores the new columns and tables.
