---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

The billing page shows plan credit and credits as separate balances and the month's "Platform fee on your own keys" as its own line. A refused own-key call on the Free plan says "Upgrade to Pro to use your own key" with one Upgrade to Pro action; otherwise it says "Add credits to use your own key", and a refused API-origin call says "API usage uses credits, not your plan credit", each with one Add credits action and no model-switch suggestion. The Plans section states the subscription and API pricing lines. `BillingBalance` in the SDK gains `creditsMicros`, `apiDebtMicros`, `paidPlanCreditMicros`, `paidCreditsMicros`, `byokPlatformFeeMonthMicros` and `byokFeeDebtMicros`.
