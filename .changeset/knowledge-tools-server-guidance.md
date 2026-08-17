---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

The `remember` and `memory_search` tool descriptions now state where saved facts actually live: a confirmed `lane: knowledge` fact enters the human-reviewed Knowledge claim lifecycle (not workspace memory), and indexed workspace documents are searched with `knowledge_search`/`knowledge_get` on the separate Document Search (docs) MCP server rather than through workspace `memory_search`.
