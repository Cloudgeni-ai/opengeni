---
"@opengeni/db": patch
"@opengeni/core": patch
---

Reduce repeated database reads during prompt admission and input-wait evaluation, and batch session artifact metadata reads while preserving live per-item authorization and bounded concurrency.
