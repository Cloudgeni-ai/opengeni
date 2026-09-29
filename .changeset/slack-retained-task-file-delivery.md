---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/db": patch
---

Add optional workspace-bot file-upload scope and an explicit, session-bound Slack retained-file delivery tool with durable upload checkpoints and uncertain-completion reconciliation. Existing bot installations remain eligible without files:write; administrators apply the canonical manifest and reinstall to enable uploads.