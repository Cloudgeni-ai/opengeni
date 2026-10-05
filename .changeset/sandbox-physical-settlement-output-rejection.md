---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Distinguish an exact committed sandbox mutation receipt from rejection of its output after authority changes. Preserve the non-retryable typed failure through SDK tools and stop later dispatches in the same invocation without hiding uncertain batch items. Missing, mismatched, rolled-back, and caller-owned transaction receipts remain unknown; existing history and recovery authority are unchanged.
