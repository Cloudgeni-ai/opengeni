---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/network": patch
"@opengeni/runtime": patch
---

Report refused MCP destinations separately from connection failures. A native account that points to a blocked or unresolvable address now shows what went wrong in connection settings, while a temporary DNS failure still retries normally.
