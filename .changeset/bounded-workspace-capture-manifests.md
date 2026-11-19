---
"@opengeni/contracts": patch
---

Workspace captures no longer publish manifests above `WORKSPACE_CAPTURE_MANIFEST_MAX_BYTES` (8 MiB): the largest diff hunks are dropped, branch comparisons first, and those files are marked truncated. The API now hands large manifests to the client by signed URL without downloading or parsing them, so a very large capture can no longer stall the server.
