---
"@opengeni/api-router": patch
---

Opening a computer session on a Connected Machine other than the one the chat is routed to now says so. Before, it could fail with the routed machine's own desktop state instead, for example "This Mac is locked" when the request named a Linux machine.
