---
"@opengeni/browserd": patch
---

A browser action's result now includes the response to a request its page handler started only after awaiting something (reading the chosen file, hashing, a validation promise). After a click, key press, typed text, choice, check, upload or pointer action, the driver gives the page one frame to start such a request and settles it like the others, so the agent no longer has to observe again to see "Imported" or "Submitted".
