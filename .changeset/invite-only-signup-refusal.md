---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

Signing up on an invite-only deployment (one with `allowedUserEmails`) with an address that isn't on the list now returns `403 { code: "SIGNUP_NOT_INVITED" }` (exported as `MANAGED_AUTH_SIGNUP_NOT_INVITED_CODE`) instead of the generic `FAILED_TO_CREATE_USER`, and a refused provider sign-up redirects with `error=signup_not_invited`. The sign-in page uses it to say that new accounts are by invitation and who to ask, in place of a "try again" that couldn't succeed. The create-account subtitle no longer speaks only to developers.
