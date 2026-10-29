---
"@opengeni/browserd": patch
---

Input sent to a browser tab hidden behind another tab, without focus emulation, now reaches the page or fails plainly. Chrome dropped the press of a click (and other non-move input) in a tab opened in the background that had never drawn, yet acknowledged it, so the click was reported done while the page got nothing. Before the first input to such a document, the driver now has the tab draw itself with a one-pixel capture, without showing it or taking focus. If the tab still cannot draw, the action fails before any input with a message saying the tab is hidden and should be activated first. Tabs that were shown before, and tabs with focus emulation, are unchanged.
