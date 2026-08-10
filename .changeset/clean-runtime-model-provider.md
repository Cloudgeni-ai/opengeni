---
"@opengeni/runtime": patch
---

Split the package-private model-provider implementation into acyclic client,
error, request-policy, routing, and transport modules while preserving the
existing public runtime surface and provider behavior.
