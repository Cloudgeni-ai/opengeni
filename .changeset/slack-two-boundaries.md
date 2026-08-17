---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
---

Slack now has exactly two authorities: the personal hosted Slack MCP grant and the OpenGeni workspace bot. The workspace-owned hosted Slack MCP connection is removed: OAuth start, reconnect, the callback fence, and capability enablement reject any non-personal ownership for `https://mcp.slack.com/mcp`. The bot manifest and canonical bot allowlist gain the bot-token Real-time Search scopes `search:read.public`, `search:read.files`, and `search:read.users` as requested-but-not-required extras, so existing installations stay eligible and gain bot search after reinstall.
