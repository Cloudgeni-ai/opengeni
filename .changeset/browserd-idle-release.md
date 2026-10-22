---
"@opengeni/browserd": patch
---

Managed browsers that nobody used for 10 minutes now stop. The profile, tabs and downloads stay on disk with the same recoverable receipt a controller shutdown leaves, and the browser's next request relaunches it on that profile with its tabs restored. Machines that host many agents' browsers, such as connected machines, no longer keep every idle browser running indefinitely. Set `idleReleaseMs` (0 disables) to change the time.
