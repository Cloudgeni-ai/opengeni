---
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Abort stalled sandbox capability and viewer-attachment requests at the React workbench warming deadline so generated-file links surface a retryable error instead of loading forever. Allow SDK viewer attachment calls to receive request cancellation options.