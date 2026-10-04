---
"@opengeni/sdk": minor
---

Add `toolServer` to `createSessionProxyHandler` and the new `@opengeni/sdk/tool-auth` entry point. The proxy attaches your product's MCP endpoint to every session it creates with a short-lived per-user HS256 token (derived from `OPENGENI_API_KEY`, audience-bound to the tool URL), applies `approvals.ask` as the session's MCP approval policy, and rotates the token on every send, steer, submit, approval, and human-input answer. Your MCP endpoint calls `verifyToolRequest(request)` to get `{ user, tenant, workspaceId }` or a 401 `ToolRequestError`. `OPENGENI_TOOL_SERVER_URL` configures the URL for both sides; `deriveToolTokenKey()` gives non-Node verifiers the signing key.
