---
"@opengeni/runtime": patch
"@opengeni/core": patch
"@opengeni/contracts": patch
---

Allow a single MCP provider to use the existing aggregate tool-count allowance instead of dropping otherwise bounded catalogs above 1,000 tools. Align permissions discovery and explicit tool selections with the same allowance. Preserve definition, response, per-provider and aggregate byte limits and shared count accounting.