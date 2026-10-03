---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Cut per-request CPU of the first-party MCP route. Within one request, the agent-attempt context, the route's session check, and a tool's entry check share identical caller-session and attempt reads (keyed by database handle and session RLS actor; re-checks after a handler's first await read fresh). Static tool inputs are built once per process, and each tool's described-input check runs once per process instead of converting every schema to JSON Schema on every request.
