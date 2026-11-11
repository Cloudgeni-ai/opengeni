---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": minor
"@opengeni/react": patch
"@opengeni/sdk": patch
---

An agent shared with its workspace now works in every Slack workspace linked to that workspace, with no separate step to make it available there. It doesn't matter where it was made: the app, a chat, a chat started in Slack (`bot_template_save` or `slack_agent_propose`) or the API. People call it by name (`@Opengeni <Name> …`), and who can use it is still decided only by Who can use it and, per Slack workspace, the existing option that lets linked organization members use it. Someone who calls an agent they can't use is told why.

Existing shared agents and bot templates join their linked Slack workspaces the first time Opengeni reads that Slack workspace's agents, or when any agent of the organization is created, renamed or shared, so a new agent never takes an older agent's name. The oldest agent keeps a name when two share it. Agents in personal workspaces stay in the app. There is no schema migration: availability still uses `agent_slack_installs` and the legacy `slack_agents` rows, which older releases read as switched on.

- Creating or renaming a shared agent whose name another agent already uses in a linked Slack workspace, or that Slack can't use, is refused with `agent_slack_name_taken` (409) or `agent_slack_name_invalid` (422), from the API, the app's form and `bot_template_save`.
- `bot_template_save` returns a `slack` field saying how people ask the new agent in each linked Slack workspace, and its description asks the agent to tell the person.
- Making an agent Only me is no longer refused: it leaves Slack, along with its channel settings and intros. The form says so.
- `AgentSlackInstall.unavailable` says why an agent isn't available in a linked Slack workspace (for example Only me, a name clash, or the current one-Slack-workspace limit). The agent page shows how to call it, or that reason, per Slack workspace; the on/off switch is gone. The open option and Introduce remain.
- `DELETE /v1/workspaces/:workspaceId/agents/:agentId/slack/:connectionId` answers 409 `agent_slack_always_available`. Make the agent Only me to take it out of Slack. The Agents API has not been in a production release or a published SDK yet, so no existing integration relied on the old answer.
- Any member who can start chats can now make an agent people call by name in Slack, in every linked Slack workspace, including Slack apps the organization shares. Before, turning an agent on in Slack needed a workspace admin. Opening it to linked organization members still needs an organization admin.
- While an agent is in one Slack workspace at a time, it goes to its own workspace's Slack app first, then those its organization shares, each by Slack workspace name. `PUT …/slack/:connectionId` on another linked Slack workspace moves it there in one step, so it is never in neither (the page's Move here, which says what it drops): open use turns off and its channel settings and intros there are cleared.
- Adding an agent to Slack on its own doesn't change the agent's version, so an open edit form still saves.
- The older `POST`/`PATCH /bot-templates` API also makes a shared template available in Slack at once. It keeps accepting names Slack can't use or that clash; such an agent stays out of Slack and its page says why.
- Making an agent Only me and then shared again starts it fresh in Slack: open use and channel settings are not kept.
- During a rolling deploy, servers on the previous release still refuse Only me for an agent in Slack and still show the old switch, which can turn Slack off. A server on this release adds such an agent back within a minute.
- `@opengeni/db` adds `listAgentsMissingFromSlack`; `putAgentSlackInstall` accepts a null actor, `automatic` for availability Opengeni adds on its own, and `moveFromOther` to move an agent between Slack installations in one transaction.

Compatibility exception: https://github.com/Cloudgeni-ai/opengeni/pull/7395#issuecomment-6741026523
