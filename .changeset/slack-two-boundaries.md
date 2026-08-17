---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/db": minor
---

Slack now has exactly two authorities: the personal hosted Slack MCP grant and the OpenGeni workspace bot. The workspace-owned hosted Slack MCP connection is removed: OAuth start, reconnect, the callback fence, and capability enablement reject an explicit non-personal ownership for `https://mcp.slack.com/mcp`, an omitted ownership on that resource defaults to personal, and `listEnabledMcpCapabilityServers` no longer runs a workspace-scoped Slack MCP installation enabled by an earlier release. The bot manifest and canonical bot allowlist gain the bot-token Real-time Search scopes `search:read.public`, `search:read.files`, and `search:read.users` as requested-but-not-required extras; apply them to the Slack app before deploying, since the install URL requests every requested scope. The bot search tool itself is a separate change.
