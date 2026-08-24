---
"@opengeni/worker-bundle": patch
---

Handle deferred tool-preparation rejection immediately so an early MCP lifecycle failure cannot surface as a process-level unhandled rejection before the lazy runtime reports the exact error at the tool boundary.