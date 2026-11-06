---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

A compute sandbox whose guest agent stops answering is restarted where it is: its host ends its VM, forgets any saved memory image and boots it again from its files on the same host, without first archiving it (memory included) to object storage. Before, a restart was a hand-off of the whole sandbox, and on a slow store that archive could take hours while the host refused every wake, so every command failed with "sandbox was not ready". A hand-off that is still storing after two minutes now gives way to a wake: the wake cancels it and the sandbox runs on from its local copy, which stays the newest copy. Hosts also tell the server through the agent link while they hand a sandbox off; the server then no longer restarts that sandbox as unresponsive (the agent sees a plain "being moved or saved by its host" status instead of a restart loop) and `sandboxes_list` shows it as recovering, with `hostBusy: "handing_off"`, instead of ready. An older host without in-place restarts still gets the hand-off restart.
