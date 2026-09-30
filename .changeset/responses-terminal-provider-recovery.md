---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Preserve bounded exact OpenAI/Azure streamed failure diagnostics separately from safe error messages, and classify provider terminal codes for existing bounded same-turn recovery. Invalid requests, safety refusals, and unknown terminal codes remain non-retryable; Codex and SuperGrok keep their transport-owned behavior.