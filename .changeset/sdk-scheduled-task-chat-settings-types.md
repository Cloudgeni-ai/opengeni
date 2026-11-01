---
"@opengeni/sdk": patch
---

The SDK's scheduled-task types now include the creator lock (`creatorLocked` on tasks and create requests) and the settings of the chats a task starts (`mcpServers`, `memoryScope`, `agentAccess`, `skills`, and `bundledSkillIds` on the agent config input), matching what the API already accepts and returns. `ScheduledTaskSkill` and `ScheduledTaskMcpServer` are exported.
