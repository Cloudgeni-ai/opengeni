---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

An agent attempt's request no longer fails with HTTP 500 when the attempt's turn moves on while the request is in flight. This covers the first-party MCP routes (`/mcp`, `/mcp/docs`, `/mcp/files`), the `/files/*` and artifact routes, and every other workspace route that enters the agent's request context. The live-attempt check passed, but the attempt's learning-policy read then went through the database's own attempt fence, which refused ("Knowledge turn attempt is stale"), and that refusal escaped as an internal error. The same happened when a route's own file-owner check found the attempt stale after the request context was entered. These cases now get the same 403 `agent_attempt_caller_stale` answer as any other stale attempt.
