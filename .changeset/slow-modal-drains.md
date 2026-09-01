---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Allow zero-holder sandbox drains to use a separate extended provider snapshot timeout without lengthening ordinary periodic or turn-end snapshot finalization, while keeping current and historical Modal rotation admission inside provider-deadline headroom and making opted-in lifecycle waiters honor an in-flight child's persisted bounded capture deadline across rolling configuration changes.