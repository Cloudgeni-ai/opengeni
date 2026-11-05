---
"@opengeni/react": patch
---

Claude subscription account rows in settings now show one tidy reading: the account's weekly limit. Model-specific weeks (such as Fable) and extra usage stay on the account's own page. Ultra plans (formerly Max 20x) no longer show a 5-hour window anywhere, and on other plans the 5-hour window appears in the list only while it is reached or nearly reached. If Claude refuses an Ultra account on a limit the list doesn't show, the row still says "Limit reached" with its reset time. Each row's limits share one grid, so labels, bars, values and reset times line up and nothing is cut off. New `subscriptionPlanWindows` and `subscriptionListWindows` helpers, an optional `plan` argument on `subscriptionAccountUsage`, and a `plan` prop on the web `ClaudeUsageReadout` and `ClaudeUsage`.
