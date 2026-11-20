---
"@opengeni/runtime": patch
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

A file attached to a turn that runs on a different sandbox provider than the deployment's default is now mounted the way that sandbox can mount it. Before, the mount was chosen for the default provider, so a Modal deployment with Azure Blob storage failed such a turn, and S3-compatible storage got the wrong mount strategy. Tests now start a turn with an attachment on every sandbox provider with every object storage backend.
