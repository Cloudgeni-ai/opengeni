---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Observe the fixed Modal materialization visibility probe through its own
cancelable provider cursor instead of borrowing the parent mutation's retained
command handle. Preserve actual failures and unconfirmed deadline evidence
without retrying materialization or agent work.