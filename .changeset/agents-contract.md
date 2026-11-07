---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Agents contract: an agent can be available in several Slack installations at once (the `agent_slack_single_install` error code is deprecated and never returned). The Slack records that pointed at `slack_agents` (channel routes, interactions, user states, proposals, intro posts, suggestions) now reference the agent's installation in `agent_slack_installs`, with the same delete behaviour, and `agent_slack_installs.install_workspace_id` records the installation's own workspace. Nothing writes `bot_templates` or `slack_agents` any more (an agent's leftover `slack_agents` row is deleted when the agent is renamed or removed from an installation) and the legacy sync triggers are dropped. The legacy Slack agents API shows an agent once per installation with the agent's own `version`; its item routes take an optional `connectionId` query parameter (SDK: the `SlackAgentInstallationOptions` argument), and opening, deleting, channels and intros of an agent in several installations need it (`slack_agent_installation_required`). Deleting a Slack agent with other installations takes it out of that installation only. Breaking for direct `@opengeni/db` users: removed the legacy bot template functions (`listBotTemplates`, `getBotTemplate`, `createBotTemplate`, `updateBotTemplate`, `deleteBotTemplate`, `BotTemplateRecord`, `BotTemplateLimitError`); use the agents data layer.
