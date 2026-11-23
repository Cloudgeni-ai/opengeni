---
"@opengeni/api-router": patch
---

A custom MCP server that can't be reached no longer fails calls to other tools. Tool calls without a remembered catalog, approvals, the MCP endpoints, the MCP sign-in consent screen and app tool calls now leave that server out, as the tool list already does. A call to that server's own tool still reports its failure.
