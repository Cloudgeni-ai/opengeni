---
"@opengeni/db": patch
---

Creating a session no longer fails when the accounts it copies from its parent turn include a shared workspace account that was disconnected, needs reauthorization or was reconnected since. The new session runs without that connector, as the parent's own turn already does, and keeps every other account. Previously every agent-spawned session from such a parent was refused until the account was restored.
