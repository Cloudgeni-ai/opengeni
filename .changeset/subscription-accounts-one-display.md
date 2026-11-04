---
"@opengeni/react": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/api-router": patch
---

Subscription accounts (Claude, ChatGPT and SuperGrok) now read the same everywhere they are listed. The "Use for next turn" account menu is wider and shows each account's full name and email, the plan once when every account shares it (or on each row when they differ), which account runs the next turn, and every usage window the provider reports with its short label ("5h", "Week", "Fable week", "Credits", "Extra usage"), the share left and when it resets. Nothing is assumed: a Claude Ultra or ChatGPT Pro account without a 5-hour limit shows none. Plans use the provider's current names ("Claude Max", "Claude Ultra", "ChatGPT Plus", "SuperGrok Heavy"), and a Claude Max account whose tier isn't known yet reads "Max or Ultra".

Claude usage also follows the October 2026 plan changes: the usage endpoint's explicit `null` for a limit the plan doesn't have (a verified Ultra plan has no five-hour limit) no longer stops an early weekly reset from ending a refusal, while an omitted or `null` window still never clears a limit that refused; the separate weekly Fable limit (`seven_day_fable`) is read and cools only Fable models; and a renewed sign-in reads the plan and Max tier from the Claude profile.
