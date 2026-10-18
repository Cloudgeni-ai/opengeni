---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Stopping a background command on a Connected Machine or compute sandbox now sends
the cancellation to the runner at once instead of waiting for the next maintenance
pass, so the process ends within moments of Stop. Stop answers within its five-second
budget; the reconciler still delivers the cancellation when that attempt fails, and
the runner's pushed exit settles the command. A stop to a compute sandbox that no
host currently serves wakes the sandbox, as any other request to it does.
