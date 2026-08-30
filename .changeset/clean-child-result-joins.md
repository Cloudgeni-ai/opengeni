---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Prevent parent agents from duplicating delegated work. Child creation now requires an independent integration plan, and `session_wait` can ignore goal/progress events until a child emits a result, settlement, or blocker.
