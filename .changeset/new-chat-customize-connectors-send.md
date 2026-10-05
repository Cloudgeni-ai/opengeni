---
"@opengeni/db": patch
---

Sending a new chat with connectors on Customize (following workspace connectors, optionally minus exclusions) no longer fails with a draft conflict. The exact-draft check now treats the saved draft and the create request as the same connector policy, and the web composer no longer shows "Draft not saved" after a Send whose draft did save.
