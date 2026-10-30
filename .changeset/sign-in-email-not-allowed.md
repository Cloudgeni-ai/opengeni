---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

On a deployment that only lets listed email addresses in (`allowedUserEmails`), someone whose address isn't listed now gets a clear refusal at sign-in instead of the generic `401 FAILED_TO_CREATE_SESSION`, which read like an outage. Email sign-in answers `403 { code: "SIGN_IN_EMAIL_NOT_ALLOWED" }` before the password is checked, so a right, wrong or unknown password gets the same answer. Passkey sign-in returns the same code, and Google or GitHub sign-in redirects with `error=sign_in_email_not_allowed`. The sign-in page (also used by the desktop and phone apps) says "This email can't sign in here. Ask your admin for access." A phone or desktop app whose address was removed between web sign-in and code redemption still gets `403 access_denied`. New `MANAGED_AUTH_SIGN_IN_EMAIL_NOT_ALLOWED_CODE` in `@opengeni/contracts`.
