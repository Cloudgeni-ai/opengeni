---
"@opengeni/api-router": patch
"@opengeni/core": patch
---

Make agent-spawned workers inherit omitted model, reasoning, and latency settings from the exact calling turn so Codex subscription sessions do not silently fall back to OpenGeni-credit models.
