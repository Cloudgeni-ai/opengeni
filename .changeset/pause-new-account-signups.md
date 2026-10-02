---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": patch
"@opengeni/sdk": minor
---

Add a launch-load safety switch that pauses new managed account sign-ups without affecting existing users. Rolling migration 0585 adds an append-only, operator-only runtime switch (`set_managed_auth_new_signups_enabled`, read by the API on every sign-up decision, so a flip applies to the next request with no restart), and `OPENGENI_MANAGED_AUTH_NEW_SIGNUPS_ENABLED=false` remains the deployment ceiling. While paused, email sign-up returns `403` with code `NEW_SIGNUPS_PAUSED` and Google/GitHub refuse unknown provider accounts with `error=signup_disabled`; sign-in, sessions, password reset, email verification, and invitation-bound account setup keep working. The managed-session client config gains an additive `newSignupsEnabled` field (absent means `true`), `@opengeni/contracts` exports `MANAGED_AUTH_NEW_SIGNUPS_PAUSED_CODE`, `@opengeni/db` exports `readManagedAuthNewSignupsSwitch`, and the control worker publishes `opengeni_managed_auth_new_signups_runtime_enabled`.
