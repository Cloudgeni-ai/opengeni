---
"@opengeni/runtime": patch
---

When a Connected Machine goes offline while a command is running, the model now hears that the machine may have gone to sleep or lost its network, or that the command may have stopped the Opengeni agent, instead of a bare "the machine is unreachable … the machine itself, not your command". It is told to check what the command did before re-running it, not to re-run a command that stops or deletes the agent, and to tell the person: "Your machine went offline while running a command that may have stopped the Opengeni agent. It restarts automatically; if it doesn't come back, open the Opengeni app on that machine (or reinstall)." When the agent has already reconnected, it says so and tells the person the agent is back. A command that never reached the machine, and a compute box, keep their existing copy.
