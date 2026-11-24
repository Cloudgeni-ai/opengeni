---
"@opengeni/react": patch
---

Paying for a plan through Stripe checkout now confirms it on return, from Billing or onboarding: a short toast says the plan is activating until billing reports it active, then names it (for example "Pro is active"). A cancelled plan checkout shows nothing new. Adds `planCheckoutReturnUrl` and `waitForActivePlan` beside the credit checkout helpers.
