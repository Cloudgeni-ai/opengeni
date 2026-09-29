---
"@opengeni/react": patch
---

Give queued Latest question callbacks a current-navigation guard so a delayed
refresh cannot reopen the queue after another history jump. Reuse canonical
execution evidence when locating queued prompts whose ledger lacks turn.started,
including tools, startup, recovery, and capacity events.