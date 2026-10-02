---
"@opengeni/contracts": major
"@opengeni/sdk": major
---

Expose additive, defaulted private-chat amount summaries and organization model payer totals. Organization and workspace totals include every usage ledger row, including another member's Only me chats and retained usage for missing or deleted sessions, without changing billing debits.

Private-chat breakdowns disclose person-level amounts only, never unseen content, titles, session/root identities, or drilldown links; detail and sample lists remain actor-visible. Workspace breakdowns share provider/model filters and are empty for root/session scopes. Organization payer totals use all model facts independently of the capped model list, distinguishing OpenGeni credits, subscriptions, and own-key billing. New lists default to empty for older responses, truncation defaults to false, and unknown cost remains unknown.

Breaking response change: `InsightsSeriesPoint.cacheHitPct`, `InsightsSpendDriver.cacheHitPct`, and `WorkspaceInsightsSnapshot.priorCacheHitPct` now permit `null` instead of inventing a percentage when cache information is unknown. Consumers must handle `number | null`, display an unknown state for `null`, and omit unknown values from numeric comparisons rather than coercing them to zero. The defaulted summary fields are additive; these existing response-field changes require the major releases. Managed-service rollout still requires the public API policy's deprecation, Sunset, and minimum 90-day compatibility period; this announcement does not waive those requirements.