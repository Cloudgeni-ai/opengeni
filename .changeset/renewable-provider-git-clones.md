---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Preserve authenticated host credential-provider Git helper chains during managed repository clones. Repository-scoped renewable helpers now work for multiple installations on one host, while ambient helpers stay excluded and explicit native connection selections remain isolated.
