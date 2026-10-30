---
"@opengeni/browserd": patch
---

On macOS, background keys to a browser window that is not its app's main window now reach that window. A batch of cmd+L, an address and Enter used to select another window's address bar, so the address was appended to the current one instead of replacing it; the window is now made its app's main window first, behind the person's app. When its app is the one in front, or the window cannot be made main, the keys are refused before any is sent with a plain next step.

Pins CUA 473b859d, which combines the window hit test, main-window keys and Simulator keys fixes.
