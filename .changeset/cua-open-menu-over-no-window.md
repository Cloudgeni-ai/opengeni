---
"@opengeni/browserd": patch
---

Choosing an item from a context menu of a background Mac app no longer fails with `element_outside_target_window` when the menu opened away from the app's windows. A context menu opened through accessibility can open at the pointer instead of at its element, so while the person works in another app it lands over that app, and the driver could not tie it to the window the agent named. The pinned CUA driver now treats an open menu over none of the app's windows as the target window's; a menu over another window of the app still belongs to that window.
