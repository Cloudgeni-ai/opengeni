---
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

Agent profiles UI (behind `OPENGENI_AGENT_PROFILES_ENABLED`): the `AgentMark` tile and `AgentAvatarPicker` (`@opengeni/react/ui/*`), agent tiles on chat rows and the chat header with "Name this agent", a composer agent chip for new and running chats, "Start with an agent" cards, the Agents pages, "Save as agent", the agent's own `agent_profile_suggest` card (kept on the chat as `Session.agentProfileSuggestion`, migration 0998), and @mentioning a saved agent to hand work to it as a child chat (`session_create` accepts `agentProfileId`).
