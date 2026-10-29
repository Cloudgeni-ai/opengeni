---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

Signing up on a deployment that restricts accounts to `allowedUserEmails` with an address that isn't on the list now returns `403 { code: "SIGNUP_EMAIL_NOT_ALLOWED" }` (exported as `MANAGED_AUTH_SIGNUP_EMAIL_NOT_ALLOWED_CODE`) instead of the generic `FAILED_TO_CREATE_USER`, and a refused provider sign-up redirects with `error=signup_email_not_allowed`. The sign-in page uses it to say that only approved email addresses can sign up and to ask whoever runs the service to allow theirs (a team invitation doesn't approve an address), in place of a "try again" that couldn't succeed. The create-account subtitle no longer speaks only to developers.
