---
"@opengeni/react": patch
"@opengeni/sdk": patch
---

An automation's agent can now be changed after it's created: pick another agent in the automation form, or pass `agentConfigPatch.agentId` (`agentName` in the automation tool) on update. **Open full form** in Add trigger now keeps the note and the chat choice. The existing-chat pickers list a person's chats with the agent from the server, so older chats show up too. Your own sidebar groups can be renamed from their row menu.
