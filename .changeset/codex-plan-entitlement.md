---
"@opengeni/codex": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
---

Recognize a ChatGPT account whose plan no longer includes the requested Codex
model (an explicit plan refusal, `usage_not_included`, or an empty HTTP 400).
The worker re-checks the account's current plan, excludes that account for that
model only, and moves the same turn to another eligible account, or fails with a
typed `codex_plan_entitlement` or `codex_request_rejected` code and plain copy.
Plan metadata now refreshes from token refreshes and usage reads, and Codex
accounts report `planCheckedAt`.
