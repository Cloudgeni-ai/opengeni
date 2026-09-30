---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/api": patch
"@opengeni/sdk": patch
---

Support a lossless scheduled-task model and reasoning patch through MCP, HTTP and the SDK. Preserve unrelated stored configuration and existing-session settings, keep normal authority validation, and reject concurrent execution-config changes instead of overwriting them.