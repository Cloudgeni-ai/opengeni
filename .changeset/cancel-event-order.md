---
"@opengeni/db": patch
---

Cancelling a chat whose stopped turn still has an unanswered tool call no longer fails when the chat also has undelivered updates (or is the cancelled chat itself): the tool calls are closed before the other cancellation events are written, so every event continues the chat's event cursor in order. Cancelling also ends the chat's input wait, which nothing would settle afterwards; migration 1229 clears the waits of chats cancelled before. Both kept archived chats from ever being stored.
