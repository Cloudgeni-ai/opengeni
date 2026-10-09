---
"@opengeni/worker-bundle": patch
---

Report unresolved Codex request outcomes as nonretryable even when the provider error lacks a native error wrapper. Preserve conversation history before settling the failure and retain the existing replay prohibition.
