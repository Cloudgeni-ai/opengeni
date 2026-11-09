---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": patch
---

Agents have one text, their Instructions: First message is gone from the agent editor, the agent page, export, `bot_template_save` and the docs. The editor is icon, name, what it helps with, Instructions, Remember across chats and who can use it. Starting a chat with an agent (`?agent=`, or an older `?botTemplateId=` link) selects it and leaves the composer as it is.

Nothing is dropped or migrated. Every read joins an existing First message after the Instructions as its own paragraph (`agentInstructionsWithFirstMessage` in `@opengeni/contracts`, `agentInstructionsSql` in `@opengeni/db`), so the editor, the API, Slack and a chat's agent layer all see the same text, and a chat with such an agent now follows it as part of its Instructions. The next change to the agent stores the joined text with an empty First message, unless the two together pass the 20,000-character limit, when both are kept as they were. `Agent.firstMessage` is always empty and `hasFirstMessage` false; the fields stay for older clients. `firstMessage` on create and update, `bot_template_save`'s `firstMessage` and `setupInstructions`, and `/bot-templates` `setupInstructions` are still accepted and become Instructions. `/bot-templates` lists only agents made as templates, with their Instructions as `setupInstructions`. The `first_message` column stays.

The agent icon picker opens on the emoji choices and colours, also for a new agent with no icon yet. Browsing the tabs or a colour chooses nothing; picking an emoji, icon or letters makes it the icon, in the colour browsed. Before, it showed only the Emoji, Icon and Letters tabs until one was clicked.

"Remember across chats" is a switch in the agent form, and new agents start with it on: from the app form (including Make this an agent) and from a chat's `bot_template_save`, which now also creates the agent's Memory collection and reports in its result's `memory.status` whether that collection is `ready`, `pending_review`, `learning_off` or `not_saved`, with a note for the person. Agents made from a Slack proposal already started with Memory on. Existing agents keep their setting, and `CreateAgentRequest.memoryEnabled` still defaults to off when the API caller omits it.
