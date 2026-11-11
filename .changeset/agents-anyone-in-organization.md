---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

An agent's Who can use it has a third choice, `Anyone in <organization>`: a shared agent that full members of its organization may also use from chat integrations, not only its workspace's members. It replaces Slack's per-Slack-workspace option that let linked organization members use an agent, so the agent decides it once and every chat integration follows it. Slack does today, and Teams will read the same setting through the integration-neutral check in `apps/api/src/integrations/organization-agents.ts`.

- `visibility` on agents (requests and responses) accepts and returns `"organization"` alongside `"private"` and `"workspace"`. Choosing it needs an organization admin (403 otherwise); narrowing it back doesn't. Only me clears it.
- Slack's safety checks for these agents are unchanged: the person must be a full member of the connected Slack team, in a conversation only that team can see, with a linked Slack account, and an active, full member of the organization, read live on every message. They are told once that the agent's workspace can see the chat, and the chat runs as the agent's read-only service principal.
- The agent page's Slack section no longer has its own open switch. `AgentSlackAvailability.open` still says whether linked organization members can use the agent there, and `PUT …/slack/:connectionId` with `open` still works: it changes the agent's Who can use it, in every Slack workspace.
- Migration 1372 adds `agents.organization_access` (default false; rolling). Every write keeps `agent_slack_installs.open` equal to it, and while an agent is in Slack its installations decide (the column only for an agent in no Slack installation), so the previous release behaves the same during the rollout and a change it makes, including closing an agent, holds, also after a rollback. The one visible effect: if a server on the previous release adds an organization agent to another Slack workspace during the rollout, the agent closes to the organization until an organization admin chooses Anyone in again (the safe direction). A later contract step backfills the column from `open` and stops reading `open`.

Agents contract (migrations 1373 to 1392): a shared agent is available in every linked Slack workspace at once. The temporary one-Slack-workspace-per-agent limit is gone, with the agent page's Move here; the `agent_slack_single_install` error code is deprecated and never returned, and `putAgentSlackInstall` no longer takes `moveFromOther`. `listAgentsMissingFromSlack` now takes the installation's `connectionId` and lists the shared agents not yet in that installation.

- The Slack records that pointed at `slack_agents` (channel routes, interactions, user states, proposals, intro posts, suggestions) now reference the agent's installation in `agent_slack_installs`, with the same delete behaviour, and `agent_slack_installs.install_workspace_id` records the installation's own workspace. Before the new keys are validated, migration 1382 cleans up rows that would fail them the way each key's delete rule would (chats and proposals are unlinked and kept; the rest are deleted) and logs the count per table.
- Nothing writes `bot_templates` or `slack_agents` any more (an agent's leftover `slack_agents` row is deleted when the agent is renamed, made Only me or removed) and the legacy sync triggers are dropped.
- The legacy Slack agents API shows an agent once per installation with the agent's own `version`. Its item routes take an optional `connectionId` query parameter (SDK: the `SlackAgentInstallationOptions` argument); channels and intros of an agent in several installations need it (`slack_agent_installation_required`). Open use and deleting act on the agent itself, as before.
- Breaking for direct `@opengeni/db` users: removed the legacy bot template functions (`listBotTemplates`, `getBotTemplate`, `createBotTemplate`, `updateBotTemplate`, `deleteBotTemplate`, `BotTemplateRecord`, `BotTemplateLimitError`) and `lockAgentLegacySlackVersion`; `legacySlackAgentAvatar` is now `agentSlackAvatar`. Use the agents data layer.
