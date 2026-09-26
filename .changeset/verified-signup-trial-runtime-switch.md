---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Add a database runtime kill switch for the one-time verified signup trial credit (rolling migration 0521). A grant now needs both `OPENGENI_VERIFIED_SIGNUP_TRIAL_CREDITS_ENABLED` and the newest row of the append-only `opengeni_private.verified_signup_trial_switch_revisions` table, which starts enabled. Operators flip it with the owner-only audited `set_verified_signup_trial_credits_enabled(enabled, operator, reason)` function. The change applies to the next setup transaction on every API replica, with no deploy or restart. Runtime roles can only read the switch. `readVerifiedSignupTrialSwitch` exposes the switch state, and the control worker publishes it as `opengeni_verified_signup_trial_credits_runtime_enabled`.
