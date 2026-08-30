---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Recover Modal command starts that fail on task-router DNS before connecting, while leaving generic unavailable, mixed-tool, and sandbox-shutdown failures non-retryable.