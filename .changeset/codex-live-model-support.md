---
"@opengeni/core": patch
"@opengeni/codex": patch
"@opengeni/api-router": patch
---

Use live Codex account catalogs for browser and agent model choices and automatic new-session defaults. Require exact model support on every permitted serving account, refresh expired credentials, and preserve provider unsupported-model explanations through the OpenAI SDK error envelope.
