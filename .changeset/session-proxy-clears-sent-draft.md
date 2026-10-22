---
"@opengeni/sdk": patch
---

With `sessionApp: true`, creating a chat no longer fails with a new-session draft conflict when the `createSession` hook changes the request. The proxy now clears the new-chat draft the session app sent once the chat exists (text-free, repositories kept, one revision on), and leaves it alone if it changed meanwhile.
