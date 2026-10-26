---
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

Agent profiles (behind `OPENGENI_AGENT_PROFILES_ENABLED`): an agent can have a home chat that @mentions are sent to, and lists the chats that wear it (`/agents/:profileId/chats`). Chats that wear a saved agent can propose updated instructions with the `agent_profile_propose_update` tool; a person reviews the diff in the chat or on `/agents/:profileId/updates` and accepting records a new version. Migrations 0999 and 1000 (rolling, 1000 is a concurrent index). The opt-in SDK client gains `listAgentProfileSessions`, `setAgentProfileHome`, `listAgentProfileProposals`, `acceptAgentProfileProposal` and `dismissAgentProfileProposal`.
