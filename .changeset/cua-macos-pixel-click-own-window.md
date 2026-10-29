---
"@opengeni/browserd": patch
---

On macOS, a pointer click on a browser dropdown in a window that is behind another window of the same browser is now refused like a click on its ref, instead of opening the dropdown's menu. The click is checked against the element under the point in its own window, not in whichever of the app's windows is on top there. Pins CUA 6121a0d7.
