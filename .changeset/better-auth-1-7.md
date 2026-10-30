---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Managed authentication now runs on Better Auth 1.7.14 (from 1.6.26), the line that receives Better Auth's security fixes. The account schema is unchanged, so there is no migration. Deployments that set `OPENGENI_BETTER_AUTH_ALLOWED_HOSTS` keep resolving the public host from `x-forwarded-host`, which 1.7 no longer trusts by default; the host must still be one of the allowed hosts. Two 1.7 defaults are turned off so authentication behaves as before: auth writes stay outside a database transaction (otherwise a password sign-up without email verification failed, because the new user was not yet visible when its first session was admitted), and auth requests no longer wait on a schema introspection of the database (a test checks the migrated schema against Better Auth's instead).
