---
"@opengeni/api-router": patch
"@opengeni/sdk": patch
---

A signed-in teammate without `enrollments:manage` who mints a Connected Machine connect command without a `scope` now gets an Only me (`user`) command instead of a refusal. Machine managers, keys and services keep the original workspace default.
