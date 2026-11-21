---
"@opengeni/api-router": patch
"@opengeni/react": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Email sign-in now requires the same Turnstile challenge as email sign-up whenever the signup challenge is enabled, to stop scripted password guessing. The Sign in form shows the widget and sends its token; refusals use sign-up's error codes. Deployments with the challenge off are unchanged.

Failed rows in the missing quiescence-receipt wake repair now log their error class and PostgreSQL SQLSTATE (no IDs or messages), so the worker's repair failures can be diagnosed.
