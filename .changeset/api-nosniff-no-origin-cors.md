---
"@opengeni/api-router": patch
---

Every API response, including errors, Better Auth routes and streams, now carries `X-Content-Type-Options: nosniff`. A request without an `Origin` header no longer receives `Access-Control-Allow-Origin: *` or any other CORS header, only `Vary: Origin`; browser requests are unchanged (allowlisted console origins keep credentialed CORS, every other origin keeps the non-credentialed wildcard for bearer-token API calls).
