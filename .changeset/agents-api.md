---
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Agents API: `/v1/workspaces/:workspaceId/agents` lists, reads, creates, changes (with `expectedVersion`) and deletes agents, with revisions, an agent's chats (yours or everyone's; Only me chats only for their owner) and Slack availability per installation (turn on or off, open, channels, intro). Every Instructions or First message change is a new revision recording who made it. Writes keep the legacy `bot_templates` and `slack_agents` rows in sync for older releases. `CreateSessionRequest.agentId` starts a chat bound to the agent and its current revision (`Session.agentId`); Slack agent chats are bound the same way and no longer copy the agent's Instructions into the chat's instructions. Bot templates, the Slack agent routes and their MCP tools keep working on top of agents; editing a bot template now needs whoever saved it or a workspace admin. New exports: the agent contracts (`Agent`, `AgentSummary`, `AgentRevision`, `AgentChat`, `AgentSlackAvailability`, request and response schemas, `AGENT_ERROR_CODES`, `agentInitialsAvatar`), the SDK client methods `listAgents`, `getAgent`, `createAgent`, `updateAgent`, `deleteAgent`, `listAgentRevisions`, `listAgentChats`, `listAgentSlackInstalls`, `putAgentSlackAvailability`, `deleteAgentSlackAvailability`, `listAgentSlackChannels` and `postAgentSlackIntro`, and the agents data layer in db.
