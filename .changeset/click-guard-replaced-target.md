---
"@opengeni/browserd": patch
---

The browser click guard no longer refuses legitimate clicks when the page re-renders the target as the pointer arrives (an identical copy now takes the click), and a double-click judges only its first press, so a "double-click to edit" row that turns into a text field on the first click still gets its double-click. On attached Chrome the guard's per-press reports are taken in before deciding a click whose document went away, so a click that reached its target is no longer reported as an unknown outcome. Each guarded click also waits on two fewer CDP round trips.
