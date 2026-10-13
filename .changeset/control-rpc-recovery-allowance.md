---
"@opengeni/runtime": patch
---

`NatsControlRpc` accepts an optional `recoveryMs` transient-failure recovery allowance. The default is unchanged (two minutes beyond the operation timeout).
