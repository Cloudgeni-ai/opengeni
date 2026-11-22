---
"@opengeni/react": patch
"@opengeni/sdk": patch
---

An automation's agent can now be changed after it's created: pick another agent in the automation form, or pass `agentConfigPatch.agentId` (`agentName` in the automation tool) on update. **Open full form** in Add trigger now keeps the note and the chat choice. The existing-chat pickers list a person's chats with the agent from the server, so older chats show up too; `listAgentChats` takes `direct: true` to keep only open chats that are with the agent itself.

In `@opengeni/react/app/lib/agent-chats`, `listAgentChats` now reads through the client's `listAgentChats` (the SDK client has it) and returns `AgentChat` rows; the `enough` option is gone. `ComposerAgentChip`'s `onBrowse` is optional: without it the menu lists every agent.
