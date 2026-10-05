---
"@opengeni/runtime": patch
---

MCP tool-call metrics (`opengeni_mcp_tool_calls_total`, `opengeni_mcp_tool_call_duration_seconds`) carry a bounded `tool` label: the tool name for a first-party Opengeni catalog tool, and `external` for every connector, API-integration, and custom tool. The `OpenGeniMcpToolLatencyHigh` alert now fires per tool and names it.
