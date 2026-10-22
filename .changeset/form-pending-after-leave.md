---
"@opengeni/react": patch
---

A dialog that its owner closes while a save is still running, such as a confirm that closes and then refreshes the page, can again be dismissed with Escape or a click outside when it is reopened. The form still tells its owner when the save ends, even after it has closed.
