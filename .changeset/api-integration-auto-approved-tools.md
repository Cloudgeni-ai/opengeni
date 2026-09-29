---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/sdk": patch
---

`installApiIntegration` accepts `autoApprovedTools`: selected write or destructive tools of a custom or curated API Integration (a curated definition may forbid specific operations) that run without per-call human approval, so scheduled and other unattended runs no longer wait forever on an approval. It needs `capabilities:manage`, passes organization integration policy again, and is declarative (omit it and every write tool asks again). Connector tool-permission and session approval-policy errors for API Integration ids now point to this setting.
