---
"@opengeni/api-router": minor
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
"@opengeni/db": minor
---

Add workspace-scoped stateless typed decisions with SDK `decide`. Reuse the
deployment's configured decision model, chat-completions authority, usage settlement
and residency checks. Calls are deployment-funded, independent of customer agent
allowances, with optional tenant-label attribution and off-path usage receipts.
Preserve typed refusals and reported, estimated and unknown provider costs.
