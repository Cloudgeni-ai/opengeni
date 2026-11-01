---
"@opengeni/runtime": patch
---

A shell command without a TTY now waits at least 60 seconds for its exit in the same `exec_command` call, even when the model asks for a shorter wait, and still returns the moment it finishes. Tests, builds and linters that used to be pushed to the background after a second, and then polled with `command_read`, now return their result in one call. Commands that should keep running in the background, such as servers, watchers and deliberate parallel runs, pass the new optional `background: true` argument (or use a TTY) to keep the requested short wait. Longer commands still continue in the background and wake the session when they finish. `OPENGENI_EXPERIMENT_CUT_POLLING=false` turns the floor off together with the long waits it extends.
