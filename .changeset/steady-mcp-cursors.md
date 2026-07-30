---
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Seed shared session-event cursors from loaded history to prevent historical replay storms, and preserve the MCP SDK's exact request-timeout classification through safe transport-error sanitization.
