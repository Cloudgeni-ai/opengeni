---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

Owners and admins can be asked to confirm admin changes with a passkey. With `OPENGENI_ADMIN_PASSKEY_STEP_UP=required`, changes to members, invitations, billing, API keys, shared integrations and settings from a browser need a session confirmed with a passkey: signed in with one, or confirmed once in that session. Creating a personal API key needs it too for an owner or admin. Otherwise the API refuses with `ADMIN_PASSKEY_STEP_UP_REQUIRED` and the console asks for the passkey, then sends the change again; the session stays confirmed until it ends. The phone app, and agents and personal API keys acting for a person, are not asked. Migration 1359 adds `auth_sessions.mfa_verified_at`.
