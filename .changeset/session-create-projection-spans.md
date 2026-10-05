---
"@opengeni/core": patch
---

Session responses hydrate the workspace once for the effective tool policy, and the session detail route reads its activity, schedules, and policy context concurrently. Session creation gains named trace spans for replay, resource validation, sandbox environment binding, model admission, and connection freezing.
