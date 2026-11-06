---
"@opengeni/api-router": patch
---

The rate limiter for public chat share-link reads and managed account setup now checks a source's own bucket before the shared one, and spends a token from each only when both admit the request. It used to take the shared token first and keep it when the source's own bucket refused, so one source sending far more than its allowance could use up the shared capacity and get other sources refused.
