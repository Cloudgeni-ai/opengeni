---
"@opengeni/browserd": patch
---

Computer use on macOS names Chrome tabs without the live memory figure Chrome adds to their accessible names ("Inbox - Memory usage - 85.2 MB" reads "Inbox"). The figure changed on every reading, so action receipts listed every tab as changed and tab refs did not stay stable.
