---
"@opengeni/core": patch
"@opengeni/contracts": patch
"@opengeni/worker-bundle": patch
---

Keep sessions usable when a previously selected MCP capability is disconnected or removed. Unavailable historical refs remain visible in effective policy but are omitted from executable tools, and the agent receives a bounded turn-level warning not to claim access to the missing source.