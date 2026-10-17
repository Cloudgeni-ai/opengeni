---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Browsers and Desktop sessions no longer keep running on a Connected Machine after the task that opened them moves to another machine. When such a session is marked lost, the server now reaches the former machine directly (with the owner's access, as any end does), ends that exact controller generation while keeping its on-disk state, and only then releases the record's controller binding; the session stays `lost`. Ending a lost session also stops it on the former machine first, instead of failing with a placement error and leaving its processes behind. If the machine is offline, nothing is released and the end explains that it can be retried once the machine is back.
