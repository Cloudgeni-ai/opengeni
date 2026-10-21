---
"@opengeni/db": patch
---

A workspace membership with role owner, or with the workspace:admin permission, now administers the workspace's subscription accounts and settings in the database, matching the API's workspace:admin check. Before, the database accepted only role admin, so such a subject passed the API check and was then refused when it connected or managed an account.
