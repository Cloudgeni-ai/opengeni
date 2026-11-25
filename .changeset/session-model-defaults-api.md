---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": minor
---

Add `setSessionModelSettings` and its HTTP endpoint so integration servers can change future session model defaults without sending a message. An optional comparison protects against overwriting a concurrent change, and retrying with the same key does not apply the update twice.
