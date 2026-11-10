---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

When a compute sandbox's host can't serve it for a while (for example while the host restarts its own agent), commands now say so. The agent is told that the host is not answering, that the machine was not restarted and that commands already started keep running. Before, it was told that the workspace machine itself had stopped and that restarting it had failed. A new `host_unavailable` value of `UnresponsiveAgentRecovery` covers this case. `command_read` and `command_wait` also keep to their requested wait when a live output refresh hangs on an unreachable machine: they return the retained output, marked as not fresh, instead of waiting minutes past the deadline.
