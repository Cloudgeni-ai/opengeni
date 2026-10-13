---
"@opengeni/storage": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Load only the selected object-storage SDK, preparing it during worker startup rather than on the first activity. Preserve synchronous storage construction and avoid retaining unused cloud-provider SDK modules at idle.
