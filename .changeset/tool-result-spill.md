---
"@opengeni/contracts": minor
"@opengeni/runtime": minor
"@opengeni/codemode": patch
"@opengeni/worker-bundle": minor
---

Spill oversized model-visible tool results to a workspace File instead of failing the tool or stuffing huge JSON into history. Codemode keeps the 16 MiB journal cap.
