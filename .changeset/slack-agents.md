---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Slack agents: named teammates people call through the Opengeni Slack app with `@Opengeni +name`, each with an icon, a description, a fixed workspace, instructions and a shared Memory. Adds the Slack agent contracts and admin API (`/integrations/slack/agents`), SDK client methods, `slackAgentId` on Slack channel routes, the `slack_agent_handoff` and `slack_agent_chats` tools for Slack-started chats, and the "Slack agent" chip. Installations without agents behave exactly as before.
