---
"@opengeni/db": minor
---

Agents legacy drop: the `bot_templates` and `slack_agents` tables and their trigger functions are dropped, `agent_slack_installs.install_workspace_id` is required, and the per-agent unique keys on Slack user states and intro records are gone, so the same Slack person or channel in two installations of one agent gets a record in each. Breaking for direct `@opengeni/db` users: removed the Drizzle `botTemplates` and `slackAgents` tables, `AGENTS_LEGACY_TRIGGER_ROUTINES` and the `agentsLegacy` retiring-feature entry. The bot template and Slack agent endpoints, their MCP tools, `?botTemplateId=` links and `slack-agent:<id>` principals keep working on top of agents.
