---
"@opengeni/runtime": patch
---

Recover required first-party MCP setup across rolling API replacements when the route temporarily returns 404 or a statusless transport error, while preserving terminal authentication, external-server, tool-invocation, and typed protocol failures.