---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

A sandbox that can no longer start programs now gets a short, actionable message instead of a raw script. Before, when a machine's `/dev/null` had been removed (for example by a command that ran `rm -rf /dev/null` as root), every command failed with "not found: spawn or apply execution containment for …" followed by the whole command text, such as the Codemode client install script, and the chat stopped with that text as its error. Now the error names only the program that was started, never the command text, and tool output says the machine could not start the program and what to try. On a compute sandbox the worker restarts the box from its disk once per turn (files are kept) and the same turn retries, shown as "Restarting the workspace machine"; if it still cannot start programs, or on a Connected Machine, the turn stops with a message that says what to do. The machine agent also keeps starting programs when `/dev/null` is gone: it keeps the null device open from startup and, running as root on Linux, puts a missing or replaced `/dev/null` back. Compute's control service gains `POST /v1/sandboxes/{id}/restart`, which boots a sandbox afresh from its disk keeping its files and shape.
