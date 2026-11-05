---
"@opengeni/runtime": patch
---

`exec_command` on Connected Machines and compute sandboxes now honours `max_output_tokens`, as the local, Modal and OpenSandbox backends already did. Output longer than the request keeps its head and tail with a "tokens truncated" marker, and the result gains an "Original token count" line; the exit-code header, background command ID and Connected Machine operation lines, and the child-cleanup notice stay intact. Before, these backends returned the whole output whatever the request, so a command such as `seq 1 3000` with a 50-token limit returned about 14,000 characters.

The sandbox instructions no longer tell the agent to search with `rg` first on machines that may not have it. They now say to use `rg` when it is installed, otherwise `grep -rn` and `find` (`Select-String` in PowerShell), and, until it is known whether `rg` exists, to choose between them in the same command so the fallback runs only when `rg` is missing. The text is the same on every backend, so the prompt stays cache-stable.
