---
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/contracts": patch
"@opengeni/react": patch
---

Opening a Site no longer moves its sidebar row, just as opening a chat doesn't. A Site row's time is the latest of its conversations, its newest published version, and the chats that published it (the one that created it and any used to edit it), as far as you can see them. Opening a Site still lists it in your sidebar.
