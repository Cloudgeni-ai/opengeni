---
"@opengeni/api-router": patch
"@opengeni/react": patch
---

The agent icon picker opens on the emoji choices and colours, also for a new agent with no icon yet. Nothing is chosen until the person picks, and picking makes it the icon. Before, it showed only the Emoji, Icon and Letters tabs until one was clicked.

"Remember across chats" is a switch in the agent form, and new agents start with it on: from the app form (including Make this an agent) and from a chat's `bot_template_save`, which now also creates the agent's Memory collection. Agents made from a Slack proposal already started with Memory on. Existing agents keep their setting, and `CreateAgentRequest.memoryEnabled` still defaults to off when the API caller omits it.
