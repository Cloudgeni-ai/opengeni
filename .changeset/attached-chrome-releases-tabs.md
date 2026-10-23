---
"@opengeni/browserd": patch
---

An agent using a person's own Chrome no longer leaves empty tabs behind or keeps Chrome's "started debugging this browser" banner up. Whatever ends a session's controller runtime (an end, an agent restart or update, or now also ten minutes without use) closes the tabs that session opened that are still blank and releases Chrome's debugger. Tabs the session did not open, tabs showing a page, and tabs another session is using stay. The session's next request continues in the tab it was using instead of opening another blank one, and a controller that starts after one crashed cleans up what it left. A debugger released by another controller is attached again on the next use instead of leaving the tab unusable.
