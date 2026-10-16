---
"@opengeni/core": patch
"@opengeni/db": patch
---

Preserve the caller's actor scope while building a capability catalog inside a transaction, so prepared MCP setup persists its replay receipt. Roll back completion writes if the receipt cannot be saved instead of reporting success.
