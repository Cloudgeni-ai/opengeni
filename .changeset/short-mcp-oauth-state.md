---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/config": patch
---

Add a rollout-gated short MCP OAuth state that stores encrypted, time-limited callback context in Postgres. Preserve legacy in-flight callbacks and one-use replay protection.
