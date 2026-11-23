---
"@opengeni/api-router": patch
"@opengeni/observability": patch
"@opengeni/runtime": patch
---

Include a bounded error class, code, and reviewed source locations in API fatal logs even when protected diagnostics are disabled. Exception messages and unreviewed paths are never copied to the log. Keep an early Connected Machine replay failure attached to its caller instead of leaking an unhandled rejection while the initial attach is still in progress.
