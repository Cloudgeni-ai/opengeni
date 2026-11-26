---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

When a model provider reports exhausted API credits, the chat now waits on the existing provider-capacity path, tells its owner once, and keeps incoming work queued until credits return or the model changes.
