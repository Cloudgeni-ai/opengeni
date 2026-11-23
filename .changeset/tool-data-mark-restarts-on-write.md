---
"@opengeni/db": patch
---

Keep app data restricted when a manager resets it while server code or a sync is writing shared-account tool data to a target it marked long before: marking again right before a write restarts the mark's reset grace.
