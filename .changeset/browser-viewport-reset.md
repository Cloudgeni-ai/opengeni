---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

A browser tab resized with the `viewport` action can now be returned to its window's own size and scale with the new `viewport_reset` action. It ends the tab's device-metrics and touch emulation, so later observations and screenshots show the window's real size and device scale factor again, and tabs that open afterwards are no longer given the size set before. Tabs that already took that size keep it until they are reset themselves. Setting a tab's observed size back with `viewport` is not the same on a display whose own scale is fractional: the window is then a fractional CSS size, observed rounded, and Chromium lays an emulated size out in whole display pixels at an emulated scale of 1, so it can come out a pixel off; `viewport_reset` restores it exactly. In a person's own Chrome, which never admitted viewport emulation, both actions are refused plainly as unsupported without sending anything to the tab.

`viewport` and `viewport_reset` also take, and stay, while someone watches the tab live. The live view samples the tab with clipped screenshots, and Chromium changes the page's emulation for each capture and then puts back what it saw when the capture began, so a change that landed during a capture was undone a moment later, and a reset could leave the tab stuck at the old emulated size even after the view closed. Both actions now hold that tab's frame sampling off while they apply, waiting for a capture already running, and then check what the page reports: the set screen size after `viewport`, and the tab's own size and scale after `viewport_reset`. A change that still did not take is sent once more and otherwise reported as an unknown outcome that asks the agent to observe the tab, never as a success.
