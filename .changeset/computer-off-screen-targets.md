---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
---

Computer targets now mark a macOS window that is off screen (minimized, hidden, or on another Space or display), which can be neither captured nor read, so an agent sees it in the listing instead of finding out from a failed read. When any listed window is off screen, the listing adds one fixed note that a browser from browser_open runs off screen and can be shown on the computer by opening it with linkedComputerSessionId.
