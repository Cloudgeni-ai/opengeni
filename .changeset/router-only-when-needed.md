---
"@opengeni/runtime": patch
---

The `tool_search`/`tool_list`/`tool_invoke` router is no longer sent when nothing is hidden behind search, and an explicit empty first-party tool selection no longer connects the first-party MCP server (it would register no tools). Once sent in a turn, or used earlier in the conversation, the router stays declared.
