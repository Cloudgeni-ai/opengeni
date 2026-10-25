---
"@opengeni/desktop": patch
---

On Windows, a desktop app run from source now uses its own app ID (the packaged ID plus `.dev`). Sharing the installed app's ID left two Start-menu shortcuts with one ID, so Windows could show the installed app's notifications under "Electron" and open the development build when one was clicked.
