---
"@opengeni/core": patch
---

MCP event sources accept servers built for ChatGPT's MCP Events integration. Those servers advertise a top-level `events` capability and number their errors -32011 to -32015, as the extension's earlier design sketch does; both are now read like SEP-3415's. An HTTP error that carries a JSON-RPC error is classified by that error, so a server that stops offering events blocks its triggers instead of being retried as a transient failure.
