---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Agents with workspace connectors but without workspace admin can now show Connect cards (`capability_authorization_request`), for example to connect the person's own computer. Catalog search and custom MCP setup stay admin-only. Tool descriptions, notices and tool results name a setup tool only when the agent has it.
