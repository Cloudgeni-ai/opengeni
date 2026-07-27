---
"@opengeni/runtime": patch
---

Use Bun's native fetch transport for MCP requests so external servers do not hang in the Undici compatibility path.
