---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
---

Owners and admins can be asked to confirm admin changes with a recent passkey. With `OPENGENI_ADMIN_PASSKEY_STEP_UP=required`, changes to members, invitations, billing, API keys, shared integrations and settings need a passkey used in the last ten minutes, also for agents and keys acting for the admin; the API refuses with `ADMIN_PASSKEY_STEP_UP_REQUIRED` and the console asks for the passkey, then sends the change again.
