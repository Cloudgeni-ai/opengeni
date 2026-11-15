---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

An agent attempt's request to a first-party MCP route (`/mcp`, `/mcp/docs`, `/mcp/files`) or any other route that enters the agent's request context no longer fails with HTTP 500 when the attempt's turn moves on while the request is in flight. The live-attempt check and the attempt's learning-policy read run together; when the turn finished, was superseded or was interrupted between them, the database's own attempt fence refused the policy read ("Knowledge turn attempt is stale") and the refusal escaped as an internal error. That refusal now gets the same 403 `agent_attempt_caller_stale` answer as any other stale attempt.
