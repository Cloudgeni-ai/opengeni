---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
---

Thread the configured Connected Machine control and exec deadlines through
`run_on`, and return truthful typed timeout/deadline command receipts without
replaying ambiguous execution.