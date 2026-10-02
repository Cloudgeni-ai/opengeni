---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": patch
"@opengeni/core": patch
---

Expose additive, defaulted private-chat amount summaries and organization model payer totals. Organization and workspace totals include every usage ledger row, including another member's Only me chats and retained usage for missing or deleted sessions, without changing billing debits.

Private-chat breakdowns disclose person-level amounts only, never unseen content, titles, session/root identities, or drilldown links; detail and sample lists remain actor-visible. Workspace breakdowns share provider/model filters and are empty for root/session scopes. Organization payer totals use all model facts independently of the capped model list, distinguishing OpenGeni credits, subscriptions, and own-key billing. New lists default to empty for older responses, truncation defaults to false, and unknown cost remains unknown.

The released v1 cache percentages retain their numeric types and original computation. Nullable cache-contract changes are deferred to a separate follow-up; this release adds no cache deprecation, response-version selector, or breaking-change exception.
