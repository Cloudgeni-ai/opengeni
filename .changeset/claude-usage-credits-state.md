---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/config": patch
"@opengeni/db": patch
---

Claude accounts now show whether paid usage credits ("extra usage") are on. The usage read takes the account's usage-credits setting from the reset programs' `event_props.extra_usage_state` (`enabled`, `disabled`, `not_configured`) and keeps the `extra_usage` object when Claude sends it (whether the credits can pay right now, and the month's cap and spend in cents). Before, the usage-credits state came only from `extra_usage`, which reads that skip spend reporting always answer with `null`, so an account with usage credits switched on showed as having none. `ClaudeExtraUsage` gains `state`, and `claudeUsageCreditsState()` gives `on`, `off` or `unknown`: a missing or unrecognized report is unknown, never off. The pooled usage response gains `usageCredits` (Claude only), each pooled account's state. Account rows carry a "Usage credits on" chip, the account page says whether usage credits are on, off or not reported, and the pooled-limits card and the organization's Claude heading name or count the accounts that have them on. This is read and display only: Opengeni never turns usage credits on, buys credits or changes auto-reload.
