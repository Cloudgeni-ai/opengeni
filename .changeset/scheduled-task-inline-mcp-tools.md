---
"@opengeni/core": patch
---

A scheduled task's `agentConfig.tools` may now name an MCP server listed in the same task's `agentConfig.mcpServers`, as a session create's tools may name its inline servers. Before, create and update checked tools against the workspace's configured servers only and returned 422 `unknown MCP server id` for a server the task attaches to the chats it starts. Unknown server ids are still rejected.
