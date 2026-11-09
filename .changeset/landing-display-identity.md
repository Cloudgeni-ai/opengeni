---
"@opengeni/api-router": minor
"@opengeni/config": minor
---

Add `GET /v1/auth/display-identity` so a marketing site can show a signed-in visitor as signed in. It resolves the visitor like `GET /v1/auth/get-session` does on a freshly loaded app tab (the selected account in session-set modes) and returns only `{ "signedIn": false }` or `{ "signedIn": true, "name", "image" }` (no email, ids or session data), with `Cache-Control: private, no-store` and `Vary: Origin`. The new `OPENGENI_LANDING_ORIGINS` setting (comma-separated exact origins, empty by default) grants credentialed CORS for that one GET path only; it never widens `OPENGENI_CORS_ALLOW_ORIGIN_REGEX`, and every other path keeps its existing CORS behaviour.
