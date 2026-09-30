---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/runtime": minor
---

Register signed credential providers and webhooks once per organization with explicit external-source filters and workspace overrides, excluding Personal workspaces. Include authorized initiating-human identity, registration lane, workspace routing and selected remote targets. Bind renewable MCP headers to normalized URLs only, restrict transport headers, skip unavailable targets and fail closed on expiry. Add immediate signing-secret rotation and canonical browser/organization-key administration. Server-only organization helpers, individual webhook reads, and secret rotation are opt-in functions from `@opengeni/sdk/workspace-integrations`, taking `client` first rather than expanding the eager browser client.