---
"@opengeni/runtime": patch
---

Allow a single MCP provider to use the existing aggregate tool-count allowance instead of dropping otherwise bounded catalogs above 1,000 tools. Preserve definition, response, per-provider and aggregate byte limits and shared count accounting.