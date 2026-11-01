---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

Adding an account with email and password (`POST /v1/auth/session-set/transactions/email-password`) in `dual` or `broker` session-set mode no longer answers a refused sign-in with `500 internal_error`. A wrong email or password is `401` with `managedAuthCode: "invalid_credentials"`; an unverified email is `403 email_not_verified`; an address the deployment doesn't allow is `403 sign_in_email_not_allowed`; any other refusal from the sign-in hooks is `403 sign_in_refused`. No account is added in any of these cases. The add-account window now names these refusals (for example "This email can't sign in here. Ask your admin for access.") and too many attempts, instead of always asking to check the credentials. The sign-up refusal for an address that isn't allowed now reads "This email can't create an account here. Ask your admin for access.", worded like the sign-in one. `ManagedAuthSessionSetErrorCode` in `@opengeni/contracts` gains the four new codes; older SDK clients see them as `http_401` or `http_403`.
