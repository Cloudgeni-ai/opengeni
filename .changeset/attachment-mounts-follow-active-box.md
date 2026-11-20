---
"@opengeni/runtime": patch
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

`buildOpenGeniAgent` now mounts attached files for its `activeSandboxBackend` instead of the deployment's default sandbox backend, matching where their downloads go. Before, a caller passing an active backend that differs from the default could get a mount its box cannot use (for example an error with a Modal default and Azure Blob storage). Tests now start a turn with an attachment on every sandbox backend with every object storage backend.
