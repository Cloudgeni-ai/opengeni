---
"@opengeni/sdk": minor
---

Add `createSessionProxyHandler(client | og, { resolve, ... })`, a packaged
same-origin backend for `@opengeni/react`'s `SessionConversation`. It
authenticates every request through the host's `resolve` hook, runs as the
resolved external user through `asUser` (never the organization key's service
authority), rejects any workspace other than the resolved one, and serves only
the native `/v1/workspaces/:workspaceId/...` routes the conversation surfaces
use, so an unmodified browser `OpenGeniClient({ baseUrl: "/api/opengeni" })`
works against it. Session creation is server-controlled through a
`createSession` hook (the browser supplies only the message and a retry key);
message bodies are bounded, cannot rotate MCP credentials or attach non-file
resources, and mutations go through an optional `authorizeMutation` CSRF hook.
