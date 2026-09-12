---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Accept Microsoft's token responses that omit offline_access from access-token scopes. Require a refresh token as proof of offline access, preserve that capability after refresh, and continue rejecting missing resource permissions.
