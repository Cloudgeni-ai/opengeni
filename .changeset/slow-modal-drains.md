---
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

Allow zero-holder sandbox drains to use a separate extended provider snapshot timeout without lengthening ordinary periodic or turn-end snapshot finalization, while keeping current and historical Modal rotation admission inside provider-deadline headroom and the complete drain transition inside the caller wait ceiling.