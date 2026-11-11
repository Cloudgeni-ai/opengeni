---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
"@opengeni/subscriptions": minor
---

Claude subscription usage now matches what Claude reports today. The usage refresh reads the account's limit reset grants (presenting Claude Code's CLI surface, which Claude requires for them) and, while at a limit, the at-limit reset program. `ClaudeSubscriptionUsage` gains optional `limitResets`, `wallReset`, `limits`, `extraUsage`, `surfaceWindows` and `serviceState`, and the SDK exports their types. The account page lists each grant with what it clears, resets left, expiry and whether it can be used now. `@opengeni/db` adds the adapter-level claim and claim-then-refresh helpers (idempotent request ids); Opengeni never claims a grant on its own.

The weekly limit model responses call `seven_day_overage_included` is treated as the weekly Fable limit: it limits Fable models only and shows as "Fable week". Responses served in the slow tier or grace zone mark a connection constrained (`SubscriptionQuota.constrainedUntil`): it still serves, but placement prefers accounts with plain capacity, and busy slow-tier slots are a short rate limit rather than the weekly limit.
