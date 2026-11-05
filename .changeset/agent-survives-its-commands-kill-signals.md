---
"@opengeni/agent-host": patch
---

A command can no longer take a Connected Machine agent offline by signalling processes. On Linux, `kill -1` in a command (it signals every process of the user) or a group signal that also hit the agent stopped the agent, and a foreground agent's keeper stopped it for good. The agent now keeps running when one of its own commands sends it `SIGTERM` or `SIGINT`, and the keeper ignores stop signals from the agent's commands and starts again an agent such a signal ended. Nothing is blocked: the command still receives every signal, and a stop from the service manager, the desktop app, a terminal or `opengeni-agent stop` works as before. On Windows each command now gets a hidden console of its own, so a Ctrl-C event a command sends to its whole console no longer stops the agent. `kill 0` and `kill -<group>` already reached only the command's own process group; a new test keeps it that way.
