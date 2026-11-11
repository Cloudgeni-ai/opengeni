---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": patch
---

An agent's Who can use it has a third choice, `Anyone in <organization>`: a shared agent that full members of its organization may also use from chat integrations, not only its workspace's members. It replaces Slack's per-Slack-workspace option that let linked organization members use an agent, so the agent decides it once and every chat integration follows it. Slack does today, and Teams will read the same setting through the integration-neutral check in `apps/api/src/integrations/organization-agents.ts`.

- `visibility` on agents (requests and responses) accepts and returns `"organization"` alongside `"private"` and `"workspace"`. Choosing it needs an organization admin (403 otherwise); narrowing it back doesn't. Only me clears it.
- Slack's safety checks for these agents are unchanged: the person must be a full member of the connected Slack team, in a conversation only that team can see, with a linked Slack account, and an active, full member of the organization, read live on every message. They are told once that the agent's workspace can see the chat, and the chat runs as the agent's read-only service principal.
- The agent page's Slack section no longer has its own open switch. `AgentSlackAvailability.open` still says whether linked organization members can use the agent there, and `PUT …/slack/:connectionId` with `open` still works: it changes the agent's Who can use it, in every Slack workspace.
- Migration 1363 adds `agents.organization_access` (default false; rolling). Every write keeps `agent_slack_installs.open` and the legacy `slack_agents.open` equal to it, and while an agent is in Slack its installations decide (the column only for an agent in no Slack installation), so the previous release behaves the same during the rollout and a change it makes, including closing an agent, holds, also after a rollback. The one visible effect: if a server on the previous release adds an organization agent to another Slack workspace during the rollout, the agent closes to the organization until an organization admin chooses Anyone in again (the safe direction). A later contract step backfills the column from `open` and stops reading `open`.
