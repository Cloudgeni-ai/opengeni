---
"@opengeni/runtime": patch
---

Without a placement, computer_open and browser_open reuse only a live session on the machine the chat is routed to now, so a chat that swapped machines no longer reattaches to a session left on the previous one.
