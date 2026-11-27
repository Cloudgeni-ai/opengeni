---
"@opengeni/react": minor
---

A new chat's first message shows on the next frame after Send, as in a running chat, instead of waiting in a disabled composer until the server has created the session. `useNewConversation` now returns `pendingPrompt` (`{ text, sentAt, resources }`) from the frame Send starts, including a prepared `creation.composer.send(text)`, until `onCreated` or a failure, and `CreatedConversation` includes the sent `resources`. `useSessionConversation` follows the `pendingPrompt` you pass while the session id is `null` and keeps it once the id arrives, so a host that keeps one controller mounted across chats shows each new chat's own first message (before, only the first prompt after mount was read). `OpenGeniChat` shows the conversation with the message, its attachments and the startup row from Send, and returns to the new-chat composer with the draft, the reason and Retry if creation fails.
