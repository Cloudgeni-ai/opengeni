---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/runtime": major
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Move agent computer interaction to managed ComputerSession tools. The legacy runtime desktop API remains exported only as a deprecated, fail-closed migration shell; because direct sandbox desktop control and model-bound tools are no longer functional, release `@opengeni/runtime` as the next major. Managed observations now carry bounded native image content for visual model input while preserving viewer control, explicit manual/on-verify recording, and historical contract parsing.