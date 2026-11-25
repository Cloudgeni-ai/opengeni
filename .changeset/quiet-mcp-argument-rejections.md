---
"@opengeni/runtime": patch
---

Exclude MCP argument rejections from the tool failure ratio regardless of server. Any MCP server can mark an `isError: true` result with `_meta["opengeni/argumentRejected"]: true`, and external JSON-RPC Invalid params errors (`-32602`) also count as rejections. This changes metrics only, not tool results or retry behavior.
