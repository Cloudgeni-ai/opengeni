---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Add SuperOffice CRM to the catalog: SuperOffice's hosted MCP server, with its six update tools asking for approval by default. When a service refuses a connection's sign-in setup, the connect dialog now says why, for example that the service only accepts apps it has approved, instead of a generic failure; the API passes the provider's OAuth error in the error details, and a provider outage during registration is now a retryable `upstream_unavailable` error. A refused sign-in that returns a standard OAuth code with a plain meaning (`invalid_redirect_uri`, `unauthorized_client`, `unapproved_software_statement`, `invalid_scope`, `server_error`, `temporarily_unavailable`) now keeps that code as the attempt's `error.code` instead of `provider_denied`. Admins can remove a custom MCP server that never connected, through the new `DELETE /v1/workspaces/:workspaceId/capabilities/:capabilityId` route and `deleteCustomMcpServer` on the SDK.
