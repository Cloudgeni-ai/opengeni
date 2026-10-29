---
"@opengeni/browserd": patch
---

Clicks in a browser tab hidden behind another tab, without focus emulation, reach the page or fail plainly, and no longer take about five seconds:

- Chrome dropped the press of a click (and other non-move input) in a tab opened in the background that had never drawn, yet acknowledged it, so the click was reported done while the page got nothing. Before the first input to such a document, the driver now has the tab draw itself with a one-pixel capture, without showing it or taking focus. If the tab still cannot draw, the action fails before any input with a message saying the tab is hidden and should be activated first.
- The press no longer waits out Chrome's roughly five-second hold of the pointer's move to a hidden page. Sent right after the move, it has the page take the move and run its handlers first.
- The click guard stays armed until it has judged the press, however long the page's handlers for the pointer's arrival take, instead of disarming five seconds after it was set up. A guard that saw no press (the press went to another document, such as a frame that appeared over the target) or ran out of time before it no longer lets the click count as delivered; the outcome is reported as unknown.
