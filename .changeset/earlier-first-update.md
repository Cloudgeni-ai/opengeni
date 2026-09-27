---
"@opengeni/runtime": patch
---

Agents skip the opening progress update only when they expect to answer within about 20 seconds, down from about a minute, so a request that takes longer shows its first message sooner.
