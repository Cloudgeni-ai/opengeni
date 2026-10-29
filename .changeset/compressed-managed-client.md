---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Compress the managed Codemode client transfer to reduce cold sandbox setup traffic while preserving the exact release digest, installed files, warm verification, and plain staging fallback.
