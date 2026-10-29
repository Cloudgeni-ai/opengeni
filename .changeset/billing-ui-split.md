---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

The billing page shows plan credit and credits as separate balances and the month's "Platform fee on your own keys" as its own line. A refused own-key call says "Add credits to use your own key", and a refused API-origin call says "API usage uses credits, not your plan credit", each with an Add credits action. `BillingBalance` in the SDK gains `creditsMicros`, `apiDebtMicros`, `paidPlanCreditMicros`, `paidCreditsMicros` and `byokPlatformFeeMonthMicros`.
