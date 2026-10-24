---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/config": minor
"@opengeni/api-router": minor
---

Add agent profiles behind `OPENGENI_AGENT_PROFILES_ENABLED` (off by default): reusable, workspace-shared agents with a name, role and avatar that a chat can start from (`agentProfileId` on session create) or switch to from its next message, plus a per-chat agent identity. New profile routes, session `agent-identity` and `agent-profile` routes, `Session.agentProfile`, `ClientConfig.agentProfiles`, an opt-in `@opengeni/sdk/agent-profiles` client, and migration 0981.
