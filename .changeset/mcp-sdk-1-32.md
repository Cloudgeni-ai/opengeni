---
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/testing": patch
---

MCP SDK 1.32.2, which fixes OAuth credentials being sent to an authorization server the resource did not advertise, unbounded request bodies, tasks not bound to their session, and a single-request denial of service. The API's MCP routes keep the API's own request-body limit rather than the SDK's new lower 4 MiB default. When a tool call's arguments fail validation, the error now lists every problem with its path instead of only the first.
