---
"@opengeni/core": patch
"@opengeni/db": patch
---

Agent Memory rules: one switch. With Memory on, an agent's chats read its collection (including unreviewed entries, labelled as such) and its other shared chats; only chats whose audience matches the collection save to it, so private chats and Slack DMs of a shared agent only read, and the Knowledge write tools refuse otherwise (`agent_memory_read_only`). Slack agents are no longer told to save with workspace scope, which let DM content reach workspace Knowledge. With Memory off, nothing is saved into the collection and `slack_agent_chats` lists nothing. App chats started with an agent get the same Memory guidance and `slack_agent_chats`. `bot_template_save` now makes an agent with standing `instructions` and an optional `firstMessage` (`setupInstructions` still works as the First message). New exports: `agentMemoryAccess`, `agentMemoryGuidance` and `agentMemoryReadOnlyMessage` (core) and `getSessionAgentMemoryState` (db).
