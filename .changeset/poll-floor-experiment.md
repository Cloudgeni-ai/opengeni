---
"@opengeni/config": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

Add an opt-in experiment, `OPENGENI_EXPERIMENT_POLL_FLOOR=true`, that makes a non-TTY `exec_command`, an empty `write_stdin` poll of a non-TTY command and a Connected Machine `command_wait`/`command_read` wait at least 30 seconds before handing back a still-running command. Exit, an input prompt or output that has gone quiet still return early, and interactive (TTY) commands, input writes and cancellation are unchanged. Set it on both the worker and the API. Off by default.
