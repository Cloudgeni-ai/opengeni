---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

A `computer_act` batch on macOS and Linux can now cross a page or form change. A later action whose role, label or text locator names an element the batch's observation does not show yet is sent to the computer by role and name; the computer finds it when that step runs, after waiting up to 10 seconds for it to appear and enable. Before, the batch was refused, so a repeated procedure needed one call per page. The tool description tells agents to do each record of a repeated procedure in one batch.
