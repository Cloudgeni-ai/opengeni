---
"@opengeni/contracts": minor
---

Open Slack agents: an organization admin can let anyone in the Slack workspace ask an agent (`open` on `PATCH /integrations/slack/agents/:agentId`, with `SLACK_AGENT_OPEN_LABEL` and `slackAgentOpenDisclosure`). Members keep using it as themselves; everyone else gets an unattended chat with no sandbox and read-only Opengeni tools that runs as the agent with the workspace's shared connections only (their tools follow the workspace tool policy; anything needing approval is refused), visible to the workspace's members. Guests, external users and shared conversations are refused.
