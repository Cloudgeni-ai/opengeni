---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

A seat-limit refusal names its one fix. The API's `402 seat_limit_reached` message is "Upgrade to Pro to add more people." or "Upgrade to Max to add more people." (whichever plan has room), or "Talk to us about Enterprise to add more people.", and its details add `seatLimit`, `seatsUsed`, `upgradePlan` and `upgradePlanLabel`. `formatErrorMessage` uses the named plan. The invite page shows it as soon as the plan is full, with one Upgrade button for people who manage billing, and tells everyone else to ask an organization owner. New: `seatUpgradePlan` in `@opengeni/contracts/seat-upgrade`, and `planSeatsFull`, `seatUpgradeFor` and `seatUpgradeFromError` in the React subscription-plan helpers.
