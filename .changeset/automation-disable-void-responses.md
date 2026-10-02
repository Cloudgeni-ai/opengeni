---
"@opengeni/sdk": patch
---

Treat successful automation source and trigger disable responses as void, so empty HTTP 204 responses resolve without attempting to parse JSON or reporting an unknown mutation outcome.