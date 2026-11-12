---
"@opengeni/runtime": patch
---

A command that fails before it is started no longer keeps its turn from finishing. When a command's preparation failed on its way to the sandbox (for example, writing the private file for a secret reference while the machine was restarting), the turn kept waiting to stop a command that never existed, until the worker gave up and restarted. The turn now releases a command whose operation was never created, and still waits for every command that was.
