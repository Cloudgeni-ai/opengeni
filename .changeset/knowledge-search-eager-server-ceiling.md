---
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

New sessions no longer save `knowledge_search` as an eager tool on an MCP server
whose deployment entry excludes it, such as an operator-configured `docs`
server. That server keeps its previous deferred connection.
