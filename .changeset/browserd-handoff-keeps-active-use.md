---
"@opengeni/browserd": patch
---

A browser still recording, or still running a request, when the agent restarts or updates is no longer stopped by the new controller as soon as it starts. Its idle release time now counts from the shutdown, as it would have on the old controller.
