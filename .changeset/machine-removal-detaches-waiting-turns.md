---
"@opengeni/db": patch
"@opengeni/sdk": patch
---

Removing a Connected Machine no longer refuses because a conversation that points at it has a queued, paused or recovering turn. Those conversations are detached like idle ones and their next attempt uses no machine; only a live machine lease or pending lease recovery still blocks removal.
