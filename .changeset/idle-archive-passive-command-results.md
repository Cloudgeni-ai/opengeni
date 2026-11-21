---
"@opengeni/db": patch
---

Let idle chats archive when their only pending updates are background command results that cannot start a turn without an explicit wait. Preserve those results for the next turn if the chat is restored.
