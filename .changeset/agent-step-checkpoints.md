---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Consolidate response and tool-result persistence under their existing attempt fences and batch queued lifecycle observations, reducing per-step database round trips without changing model inputs.
