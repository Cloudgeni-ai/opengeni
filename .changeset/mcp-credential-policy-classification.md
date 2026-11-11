---
"@opengeni/api-router": patch
---

A restricted organization integration policy that allows custom MCP servers (`custom:mcp`) no longer refuses an MCP server's OAuth credential stored or rotated through the connections API. A connection of kind `oauth2` with an MCP server URL in `metadata.mcpUrl`, no other credential role, and a matching `metadata.resource` when one is set now counts as that MCP server. That is `custom:mcp`, or the reviewed Gmail, Google Drive, Google Calendar or Slack key for their own servers, the same keys the native MCP sign-in uses. Products that act as their own OAuth server can now provision and rotate each person's MCP credential under a restricted policy. Credentials that name no such server are still refused.
