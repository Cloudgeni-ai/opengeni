---
"@opengeni/api-router": patch
---

First-party MCP handshakes cost one database read. Every POST to the first-party MCP route used to build the whole tool surface first: session authorization, the agent's learning policy, the workspace, its model catalog, Memory scope and admin access, about 42 statements in eleven transactions. A client connect is three POSTs (initialize, notifications/initialized, tools/list), so each turn's connect paid that three times. For a session-bound agent attempt, `initialize`, `ping` and notifications now only prove that the caller is the live attempt (BEGIN, setup, one read, COMMIT) and are answered by a tool-less server with the same name, version and capabilities, so the reply is identical. A stale attempt is refused with the same error as before, and `tools/*` requests still build the full surface.
