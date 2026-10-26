---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A turn that fails while a command is still waiting for its sandbox, for example because the sandbox could not be created, now records that command as not started instead of outcome unknown, so Retry stays available. Such a call is closed when it is recorded: if the sandbox comes up later, the command is not sent.
