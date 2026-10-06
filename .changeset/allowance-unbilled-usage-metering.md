---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Usage allowances can count usage that spends no Opengeni credits. Set `unbilledUsage: "list_price"` on a workspace allowance to count model calls on connected subscriptions, workspace or organization keys, and deployments without credit billing at their configured list price, and to admit those turns against the workspace and member ceilings. The default, `"ignore"`, keeps allowances credit-only.