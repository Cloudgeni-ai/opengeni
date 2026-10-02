---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Default omitted latency mode to standard for fresh agent-created sessions while preserving model and reasoning inheritance. Explicit faster modes retain model validation, and creation replay and later messages preserve accepted settings.