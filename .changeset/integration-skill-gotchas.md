---
"@opengeni/runtime": patch
---

Bundled integration guidance adds build gotchas (always pass `baseUrl`,
per-session MCP servers must also be selected in `tools` and be publicly
reachable, `sandboxBackend: "none"` for pure chat/tool agents, pause vs
cancel for Stop, scheduled tasks for background agents), a single bundled
question for the user-owned choices, and the per-user workspace option.
