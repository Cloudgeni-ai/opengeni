---
"@opengeni/core": patch
---

Triggering a paused schedule (Run now, the API or the agent tool) is now refused with a clear "resume it first" error. Before, the trigger was accepted and reported as triggered, but the paused schedule never ran and no run was recorded.
