---
"@opengeni/browserd": patch
---

Computer sessions on Windows no longer list the CUA worker's own cursor overlay as a window. Windows names the worker `cua-driver.exe`, so the overlay filter missed it, and opening a computer could pick the overlay for its first screenshot, which CUA refuses because it never targets its own process.
