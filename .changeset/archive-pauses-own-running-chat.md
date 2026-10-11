---
"@opengeni/api-router": patch
---

Archiving a chat you started now also pauses it when it still has work: a running or queued turn, a pending wait, or an active goal. Before, an archived chat kept running out of sight. The pause is the ordinary Pause (Resume brings it back, and a paused chat runs no goal continuations), it happens once per archive even if the request is retried, and it only applies when you may control chats. Archiving a chat someone else started still only hides it for you, and settled chats are not paused.
