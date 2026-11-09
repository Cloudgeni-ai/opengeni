---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
"@opengeni/api-router": patch
---

People on a plan that doesn't include their own subscriptions (Codex, Claude, SuperGrok) now hear it before Send instead of after it. The workspace model catalog returns `ownSubscriptionPlan` (`{ key, label, monthlyPriceMicros }`) and the same `requiredPlan` on each own-subscription model while the organization's plan doesn't include them. The plan is the cheapest self-service plan that does, from the plan catalog (`ownSubscriptionUpgradePlan` in `@opengeni/contracts/billing-origin`). Connect pages and onboarding say "Using your own subscription needs Pro ($20/month).". The web and React Native model pickers label those models "Needs Pro" (`requiredPlanHint`) and keep them selectable. The new-chat page shows a notice with one action when one is chosen, and a one-time dismissible heads-up to people who connected one earlier.
