---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

A browser tab resized with the `viewport` action can now be returned to its window's own size and scale with the new `viewport_reset` action. It ends the tab's device-metrics and touch emulation, so later observations and screenshots show the window's real size and device scale factor again, and tabs that open afterwards are no longer given the size set before. Tabs that already took that size keep it until they are reset themselves. Setting a tab's observed size back with `viewport` is not the same on a display whose own scale is fractional: the window is then a fractional CSS size, observed rounded, and Chromium lays an emulated size out in whole display pixels at an emulated scale of 1, so it can come out a pixel off; `viewport_reset` restores it exactly. In a person's own Chrome, which never admitted viewport emulation, both actions are refused plainly as unsupported without sending anything to the tab.
