---
"@opengeni/browserd": patch
---

A keyboard shortcut that opens a window on macOS, such as cmd+n, now returns that window's observation. CUA runs the shortcut as the menu command behind it, which confirms nothing and opens the window only after it returns, so the result used to show the old window unchanged and say the input may not have taken effect. When a key press comes back unconfirmed and its window reads as before, the backend now waits up to 600 ms for a new window of the same app. If exactly one appears, and it is not a sheet, the action reports that it opened that window. Two new windows, another app's window, or a press that changed its own window keep the original target.
