---
"@opengeni/sdk": patch
---

`createEventSource({ kind: "mcp", serverId })` now creates a working MCP event source: automations can trigger on events from MCP servers that offer the MCP Events extension, delivered by webhook or polling. `listEventSourceTypes` lists the server's event types with their argument schemas, and triggers on MCP sources take `arguments`.
