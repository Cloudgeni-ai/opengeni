---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/runtime": patch
"@opengeni/react": patch
---

App server code: `env.tools.call` returns the tool's JSON value, read the same way app syncs read it, and throws `tool_error` when the tool fails. `{ raw: true }` returns the MCP result. Code uploaded before this change keeps getting the MCP result. The chat panel inside an app can copy a link to its conversation.
