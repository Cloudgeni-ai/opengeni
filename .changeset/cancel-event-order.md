---
"@opengeni/db": patch
---

Cancelling a chat whose stopped turn still has an unanswered tool call no longer fails when the chat also has undelivered updates (or is the cancelled chat itself). The tool calls are closed before the other cancellation events are written, so every event continues the chat's event cursor in order.
