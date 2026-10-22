---
"@opengeni/api-router": patch
---

A browser controller resource that is gone for good, such as an attached Chrome profile that reconnected under a new connection, now reaches the agent as a 409 with the controller's guidance ("open a new browser session") instead of a generic "temporarily unavailable, retry" that never succeeds.
