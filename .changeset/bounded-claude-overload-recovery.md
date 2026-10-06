---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Recover confirmed Claude overload on the same accepted turn for at most 15 retries
within a 15-minute durable recovery window. Require structured provider evidence,
honor Retry-After only inside that window, and reject expired retries before
dispatch. Preserve the selected budget and delay through checkpoint database
outages without replaying completed tools or changing account/model selection.
Other failure classes retain their existing recovery behavior.

Ship runtime and turn/control workers with the workflow bundle from the same
source release; no database migration or configuration change is required.