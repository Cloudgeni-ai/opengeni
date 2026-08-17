---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

The `remember` and `memory_search` tool descriptions now tell the agent that approved Knowledge facts are retrieved with `knowledge_search`/`knowledge_get` on the separate Document Search (docs) MCP server rather than the first-party server.
