---
"@opengeni/api-router": patch
---

An app's tool list no longer fails when one custom MCP server in the workspace can't be reached. `GET /tools/catalog` and `/tools/declarations` now leave that server out, as an agent turn does, instead of answering 500 for every tool. A call aimed at that server still reports its own failure.
