---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/api-router": minor
"@opengeni/sdk": minor
---

Add a launch-load safety switch for managed deployments. `OPENGENI_MANAGED_AUTH_NEW_SIGNUPS_ENABLED=false` refuses new accounts (email sign-up returns `403` with code `NEW_SIGNUPS_PAUSED`; Google/GitHub refuse unknown provider accounts with `error=signup_disabled`) while existing sign-in, sessions, password reset, email verification, and invitation-bound account setup keep working. The managed-session client config gains an additive `newSignupsEnabled` field (absent means `true`), and `@opengeni/contracts` exports `MANAGED_AUTH_NEW_SIGNUPS_PAUSED_CODE`.
