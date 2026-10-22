---
"@opengeni/browserd": patch
---

Browsers left running when the agent restarts or updates no longer run forever. A controller that shuts down now stops browsers already unused for the idle release time instead of handing them off, and records each browser it does hand off. Its successor stops a handed-off browser once it has gone unused for the idle release time, asking Chrome to close first so its tabs come back on the next use. At startup the agent starts the controller of any scope that has such browsers waiting, so they are stopped even if no chat uses a browser there again.
