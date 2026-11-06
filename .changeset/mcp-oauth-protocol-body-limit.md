---
"@opengeni/api-router": patch
---

The MCP OAuth protocol posts (`POST /oauth/register`, `/oauth/authorize` and `/oauth/token`) now refuse a request body larger than 16 KiB with 413 while it streams, before parsing it. They previously had only the generic API request-body ceiling, so a large anonymous form or JSON body was read and parsed in full before any check. Normal OAuth requests are far below the new limit.
