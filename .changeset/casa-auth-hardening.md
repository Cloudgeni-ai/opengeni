---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
---

Managed sign-in now allows at most 100 password attempts per account per hour (20 from one address), down from up to 200. New passwords found in the Have I Been Pwned breach corpus are refused at sign-up, password reset, password change and invited-user account setup; only a five-character hash prefix leaves the API, the check is on outside local and test environments by default (`OPENGENI_MANAGED_AUTH_BREACHED_PASSWORD_CHECK` overrides it), and an unreachable lookup never blocks anyone. Better Auth log lines no longer carry request bodies, links, tokens or email addresses. Delegated access tokens (`ogd_`) that would stay valid for more than 24 hours are refused.
