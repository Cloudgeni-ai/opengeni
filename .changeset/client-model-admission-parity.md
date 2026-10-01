---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Resolve caller-scoped client model lists and fresh session creation through the same workspace selection rules, including credential readiness, policy, and connection model permissions. Hide unavailable subscription models from public bootstrap, support an explicit workspace selector in client config, and allow an empty selectable model list.