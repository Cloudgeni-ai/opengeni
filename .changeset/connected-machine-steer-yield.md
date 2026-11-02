---
"@opengeni/runtime": patch
---

On a Connected Machine, a shell command now waits up to 60 seconds for its exit in the same `exec_command` call, the same finish floor as a managed sandbox (it was 30 seconds), so commands that take between 30 seconds and a minute no longer need a `command_read` afterwards. A Steer no longer waits for that window to end: the turn asks the running command to return its background handle at once, and the command keeps running and reports its result when it finishes. Pause and cancel still stop it at once. With `OPENGENI_EXPERIMENT_CUT_POLLING=false` the Connected Machine wait stays capped at 30 seconds.
