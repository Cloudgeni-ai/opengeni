---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Move agent computer interaction to managed ComputerSession tools. Remove the legacy model-bound desktop capability and automatic on-turn recording path while preserving viewer control, explicit manual/on-verify recording, and historical contract parsing.