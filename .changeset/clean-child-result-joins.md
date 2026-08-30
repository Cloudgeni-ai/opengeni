---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Prevent parent agents from duplicating delegated work. Child creation now requires an independent integration plan, and `session_wait` can ignore messages, goal/progress events, maintenance turns, and continuation segments until a child produces a result-bearing final turn or blocks.
