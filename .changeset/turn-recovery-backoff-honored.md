---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

A recovering turn now honors its retry backoff: the deadline is stored on the turn and armed as a delayed wake, so the session's own wakes no longer cut it short and only new user input ends it early. A required MCP server that answers 503 (for example during a deployment) is waited out for up to ten minutes instead of using up the five quick retries.
