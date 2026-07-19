---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Make initial session creation atomic and retry-verifiable, including canonical events and admission, usage and source settlement, and post-commit revisioned Temporal wake delivery.