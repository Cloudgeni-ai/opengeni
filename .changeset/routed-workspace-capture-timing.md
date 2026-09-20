---
"@opengeni/runtime": patch
"@opengeni/observability": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Measure workspace capture gate waits on every routed sandbox operation, including
mid-turn and API-direct operations, without changing provider-call accounting or
admission guarantees. Record physical warm capture and publication duration at
actual settlement, including captures that outlive the initiating caller.