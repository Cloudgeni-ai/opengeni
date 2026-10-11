---
"@opengeni/config": patch
"@opengeni/runtime": patch
---

Stop failing turns when the deployment's own API is briefly slow. Opengeni's built-in MCP servers (`opengeni`, `files`, `docs`) inherited the MCP client's 5-second default for `initialize` and `tools/list`, so during a rolling restart or a busy period every turn start timed out, and turns exhausted their recovery budget within a few minutes. MCP server configs now accept `setupTimeoutMs`, which bounds only session setup (and the outer connect fence); the built-in servers use 30 seconds. Tool-call timeouts are unchanged.
