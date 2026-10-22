---
"@opengeni/runtime": patch
---

When an optional integration can't connect or list its tools because its connection was rejected with HTTP 401 or 403, tool search now says so and suggests signing it in again. Before, these rejections showed only as "code 401" without that suggestion, because the MCP client reports the HTTP status as an error code.
