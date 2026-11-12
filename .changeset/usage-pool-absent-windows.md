---
"@opengeni/subscriptions": patch
---

The subscription usage pool no longer reports a five-hour "Observed pool exhaustion" for accounts that have no five-hour limit. Codex plans with only a weekly limit report no five-hour window, and an account at its weekly limit used to be counted in the five-hour total as nothing usable. When it was the only account in that total, the whole pool read 0 % and "runs out now", even while other accounts served normally. A complete usage reading that omits a window now marks the account as not having it. The account is listed as unknown in that window and kept out of its total and forecast. A window that no account has reports "No account has this limit.", and a usage-limit deadline that matches no reset is placed in a window the account has. A refusal of a window still counts, and refusals, response headers and incomplete providers never mark a window absent.
