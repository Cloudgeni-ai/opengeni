---
"@opengeni/core": minor
"@opengeni/db": minor
---

Microsoft Teams (with workspace routing) now serves agents whose Who can use it is `Anyone in <organization>` to full members of the connected Teams tenant who aren't in the agent's workspace, with Slack's open-agent rules: 1:1 chats only, never guests (Teams' `getMemberById` must say `userRole` "user" in the connected tenant), live organization membership at enqueue, admission and delivery, and a one-time notice that the workspace's members can see the chat, which runs as the agent's read-only service principal `teams-agent:<agentId>`. A one-off `in <Workspace>: …` message continues the person's chat there and its replies start with a `**Workspace**` header.

- Stored Teams chat choices and switch-card options must name a shared agent of the named workspace (`teams_route_target_invalid`); a card needs the person's live link (`teams_link_missing`) and holds at most 100 options (`TEAMS_ROUTE_PROMPT_MAX_OPTIONS`); a reach change committed during an enqueue's access check refuses it (`teams_reach_changed`).
- Breaking for direct `@opengeni/db` users: `clearTeamsChatChoice` takes `{ actorId, subjectId }` and clears only that person's choice. `listTeamsAgentDirectory` accepts `preferWorkspaceIds`, returns `organizationAccess` and reads up to 1,000 agents. New: `getTeamsAgentInWorkspace`, `getTeamsTurnRouting`, `teamsOrganizationAgentSubjectId`, `teamsOrganizationAgentIdFromSubject`, `TEAMS_ORGANIZATION_AGENT_ROUTE_PREFIX`, `AGENT_ORGANIZATION_ACCESS_SQL`.
