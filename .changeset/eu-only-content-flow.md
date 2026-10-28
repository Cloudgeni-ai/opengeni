---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/runtime": minor
"@opengeni/core": minor
---

EU-only content stays in EU-only workspaces. A session reaching another workspace (session tools given a `workspaceId`, or `admin_action_call` naming one by id or by external identity) is refused when it would bring an EU-only workspace's content into a workspace that isn't EU-only, or carry an EU-only session's messages or changes there; nothing runs when the setting can't be read. API routes answer such a refusal with the new error code `region_restricted` (HTTP 422). New `@opengeni/db` exports: `assertWorkspaceContentFlowAllowed`, `assertWorkspaceContentExchangeAllowed`, `assertOrganizationContentFlowAllowed`, `assertOrganizationContentExchangeAllowed`, `workspaceContentFlowEnd` and `WorkspaceContentFlowRefusedError`.

Opengeni's own MCP endpoints added to a workspace as a remote MCP server get the calling workspace in an opaque, encrypted `x-opengeni-calling-workspace` header, sent for Opengeni's own host however it is spelled and for any request carrying an Opengeni API key or MCP OAuth token. Each MCP endpoint refuses a call beyond the handshake before it runs unless content may go both ways between the calling workspace and what it reached, and one middleware on `/v1/mcp` and every `/v1/workspaces/:workspaceId/mcp` endpoint fails closed when an endpoint skipped that check. MCP OAuth consent for Opengeni's own client, and saving an Opengeni API key as an MCP credential, are checked both ways too. New `@opengeni/contracts` exports: `OPENGENI_CALLING_WORKSPACE_HEADER`, `signCallingWorkspaceProof` and `verifyCallingWorkspaceProof`; new `@opengeni/runtime/calling-workspace` entry point; new `@opengeni/core` export `assertMcpCredentialContentFlowAllowed`.
