---
"@opengeni/db": patch
---

Keep messages from the same caller attempt together with Agent Steer so older messages do not trigger a later inference. Preserve context-before-Steer ordering when persisting model history with a goal snapshot, while retaining isolation between different callers and access settings.
