---
"@opengeni/react": patch
---

Claude subscription account rows in settings now show one tidy reading: the account's weekly limit. Model-specific weeks (such as Fable) and extra usage stay on the account's own page. The 5-hour window appears in the list only while it is reached or under 10% left. On Ultra plans (formerly Max 20x) the 5-hour window shows only while it is reached or under 10% left in the list, on the account page and in the chat account menu, since Claude still reports it and can refuse on it. Each row's limits share one grid, so labels, bars, values and reset times line up and nothing is cut off. New `subscriptionPlanWindows` and `subscriptionListWindows` helpers, an optional `plan` argument on `subscriptionAccountUsage`, and a `plan` prop on the web `ClaudeUsageReadout` and `ClaudeUsage`.
