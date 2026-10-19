---
"@opengeni/browserd": patch
---

In the user's own Chrome, a click that submits a form or follows a link now returns the page it led to, as in managed browsers, instead of the page it left. Debugger events reach browserd by polling there, so an action now waits until the events Chrome sent before its last reply have been seen before deciding whether a navigation is pending.
