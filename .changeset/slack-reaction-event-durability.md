---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Preserve one durable task per distinct authorized Slack reaction when concurrent events share a canonical session, including replay after an ambiguous inbox settlement.