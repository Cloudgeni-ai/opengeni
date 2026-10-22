---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

When an optional integration (a connected MCP server) can't connect or list its tools during a turn, tool search and tool list results now name it with a short reason, such as "connected but could not list its tools (HTTP 401); its connection may need to be signed in again". Before, its tools simply vanished: a search found nothing, and the agent told the person it had no access instead of saying the integration was failing.
