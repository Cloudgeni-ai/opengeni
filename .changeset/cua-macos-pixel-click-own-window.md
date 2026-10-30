---
"@opengeni/browserd": patch
---

On macOS, a pointer click on a browser dropdown in a window that is behind another window of the same browser is now refused like a click on its ref, instead of opening the dropdown's menu. The click is checked against the element under the point in its own window, not in whichever of the app's windows is on top there. Pins CUA 473b859d, which combines the window hit test, main-window keys and Simulator keys fixes.
