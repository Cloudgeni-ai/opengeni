---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Add SuperOffice CRM to the catalog: SuperOffice's hosted MCP server, with its six update tools asking for approval by default. When a service refuses a connection's sign-in setup, the connect dialog now says why, for example that the service only accepts apps it has approved, instead of a generic failure; the API passes the provider's OAuth error in the error details. Admins can remove a custom MCP server that never connected, through the new `DELETE /v1/workspaces/:workspaceId/capabilities/:capabilityId` route and `deleteCustomMcpServer` on the SDK.
