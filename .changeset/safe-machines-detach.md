---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Make connected-machine removal show every dependent session and support an explicit atomic move-to-default-sandbox confirmation before revocation. Surface typed sandbox swap rejections as visible React mutation errors instead of treating resolved failures as success.