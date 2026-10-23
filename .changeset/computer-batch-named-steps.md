---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

A `computer_act` batch on macOS and in Linux sandboxes can now cross a page or form change. A later action whose role, label or text locator names an element the batch's observation does not show yet is sent to CUA by role and name; CUA finds it when that step runs, after waiting up to 10 seconds for it to appear and enable. Element-targeted actions after it are found by name too (an exact name for a ref), since CUA's lookup retires the observation's tokens. CUA is pinned to a revision whose lookups and checks accept `exact`. The tool description tells agents to do each record of a repeated procedure in one batch.
