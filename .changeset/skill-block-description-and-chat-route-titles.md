---
"@opengeni/db": patch
"@opengeni/observability": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

Skills whose SKILL.md description is a multi-line YAML block install again: the installed Skill's summary folds line breaks into spaces, and any remaining invalid Skill metadata returns a 422 instead of a server error. Chat titles now work on chat-API routes that report unset usage counters as null, and a failed title logs a content-free reason (the failing stage, error name and provider status or code).
