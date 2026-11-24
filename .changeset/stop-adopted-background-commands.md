---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Pause, terminal Cancel and an explicit stop now stop an unsupervised session background command's process group. Before, such a command was only marked stopping and kept running, so a process that ignored interrupts could still write after it should have stopped. Slow turn settlements and Steer handovers are now logged with the time spent in each phase.
