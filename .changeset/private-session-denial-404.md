---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Another member's private session is now indistinguishable from a missing one
on every session route. Request-facing session authorization refuses a target
the caller cannot see (including one that does not exist) as `404` before the
route runs, instead of letting routes such as `GET .../queue`,
`GET|PUT .../composer-draft`, `POST .../events` and `POST .../control` fail
with a retryable `500` on the absent row. A missing session is now refused
before request-body validation.
