---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Email sign-in can now require the same Turnstile challenge as email sign-up, to stop scripted password guessing. Turn it on with `OPENGENI_SIGN_IN_CHALLENGE_ENABLED=true` (default off; needs the signup challenge on). The client config then reports `signInChallengeRequired`, the Sign in form shows the widget and sends its token, and refusals use sign-up's error codes.

Failed rows in the missing quiescence-receipt wake repair now log their error class and PostgreSQL SQLSTATE (no IDs or messages), so the worker's repair failures can be diagnosed.
