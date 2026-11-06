---
"@opengeni/api-router": patch
"@opengeni/config": patch
---

The unauthenticated local access mode no longer answers with wildcard CORS when `OPENGENI_ENVIRONMENT` is something other than `local` (for example the Helm single-node profile). In local access mode, in any environment, only the `OPENGENI_WEB_BASE_URL` and `OPENGENI_PUBLIC_BASE_URL` origins and the exact origins in `OPENGENI_LOCAL_ALLOWED_ORIGINS` receive CORS responses; other origins get no CORS grant. The web app served from the API's own origin is unaffected. A browser app that calls such a deployment from another origin needs that origin in `OPENGENI_WEB_BASE_URL` or `OPENGENI_LOCAL_ALLOWED_ORIGINS`. The `Host` checks of the local development stack are unchanged and still apply only in the `local` environment.
