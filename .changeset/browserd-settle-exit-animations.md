---
"@opengeni/browserd": patch
---

Browser actions no longer report a menu, listbox or dialog that the action just closed as still open. Before the post-action snapshot, the driver briefly waits for finite running animations to finish, so exit animations complete and the element leaves the page first. Infinite animations such as spinners are ignored, and the wait is capped at 750 ms.
