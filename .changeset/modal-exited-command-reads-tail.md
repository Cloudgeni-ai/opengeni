---
"@opengeni/runtime": patch
---

A fast foreground command on a Modal sandbox returns as soon as it exits again, with its output receipt, when the command router delivers the end of its output more slowly than the turn's 250 ms read slice, which can happen once a box is shared by a parent and a child session or was resumed. Before, each slice ended before the router's end-of-output arrived, so an exited command kept showing "Process running" and only settled through the lease reaper's 30-second sweep, costing 60 to 120 seconds per command. Once the router reports the exit, a read now keeps reading the finite rest of the output for up to four seconds within the same page. A running command still returns at its slice, and a command whose pipe stays open after exit pays the extra wait only once.
