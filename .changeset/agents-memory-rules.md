---
"@opengeni/core": minor
"@opengeni/db": minor
---

Agent Memory rules: one switch. With Memory on, an agent's chats read its collection (including unreviewed entries, labelled as such) and its other shared chats; only chats whose audience matches the collection save to it, so private chats of a shared agent only read, and the Knowledge write tools refuse otherwise (`agent_memory_read_only`), also for collections inside it. An agent's Slack DMs save no Knowledge at all: their session rows are shared, so a save would reach workspace Knowledge (the old DM leak). With Memory off, the collection is not read (`agent_memory_off`), nothing is saved into it and `slack_agent_chats` lists nothing. App chats started with an agent get the same Memory guidance and `slack_agent_chats`. `bot_template_save` now makes an agent with standing `instructions` and an optional `firstMessage` (`setupInstructions` still works as the First message) and returns `{ ok, agent }` instead of `{ template }`. New exports: `agentMemoryAccess`, `agentMemoryGuidance`, `agentMemoryReadOnlyMessage` and `AGENT_MEMORY_UNREADABLE_MESSAGE` (core) and `getSessionAgentMemoryState` (db).
