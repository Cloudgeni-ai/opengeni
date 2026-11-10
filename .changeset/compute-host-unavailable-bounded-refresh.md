---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

When the compute service answers a sandbox restart with `503 unavailable` (most often because the host is restarting its own agent), commands now say so. The agent is told that the restart could not be carried out or confirmed, so the machine was probably not restarted, and that it should check running commands with `command_read` before re-running anything. Before, it was told that the workspace machine itself had stopped and that restarting it had failed. A new `host_unavailable` value of `UnresponsiveAgentRecovery` covers this case.

`command_read` and `command_wait` also keep to their requested wait when live output refreshes hang on an unreachable machine. One bound covers all the commands in a read, and cancelling stops the wait. They return the retained output, marked as not fresh, instead of waiting minutes past the deadline.
