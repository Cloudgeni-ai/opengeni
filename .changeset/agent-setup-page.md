---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Agents gain a lean setup page: Starts when (automations that start a chat with the agent), Can use (Allow, Ask first or Block per connector and tool, for every connection type), Learns (Memory entries you can edit or remove), Who can use and a short Skills list. Agents carry new `toolPermissions`, `skills` and `templateKey` fields, scheduled tasks accept `agentConfig.agentId`, and the SDK adds `listAgentTemplates` and `createAgentFromTemplate` for the ready-made agents in the "Add an agent" gallery. Agents can start a chat with another agent by name or id through `session_create`'s `agentName` parameter. Existing fields and requests are unchanged.
