---
"@opengeni/api-router": patch
---

`/v1/config/client` now reports `auth.emailVerificationRequired` from the same setting the server enforces (`OPENGENI_MANAGED_AUTH_REQUIRE_EMAIL_VERIFICATION`, defaulting to required outside local). A managed deployment that turns verification off no longer tells new people that a verification link was sent when none is.
