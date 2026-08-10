---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Make connected-machine removal show every dependent session and support an explicit canonical move-to-default-sandbox confirmation before revocation. Default moves prove managed sandbox readiness through the existing fleet route, active turns remain fail-closed, and typed swap rejections surface as visible errors instead of false success.