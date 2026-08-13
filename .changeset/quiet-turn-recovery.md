---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Retry transient pre-inference attempt claims atomically, and durably re-wake a
recovering logical turn when its activity failed before creating an attempt.
