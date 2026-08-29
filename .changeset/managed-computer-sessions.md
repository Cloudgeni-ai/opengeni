---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Move agent computer interaction to managed ComputerSession tools. Preserve the runtime 1.x legacy desktop API as a deprecated, fail-closed compatibility shell while removing its model-bound tools and automatic on-turn recording path. Managed observations now carry bounded native image content for visual model input while preserving viewer control, explicit manual/on-verify recording, and historical contract parsing.