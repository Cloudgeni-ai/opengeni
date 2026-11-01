---
"@opengeni/react": patch
---

Two messages sent in quick succession from the composer (Send, then Steer or another Send while the first is still on its way) now both arrive, in order. Before, the second message's draft save could land between the first message's save and its submit, so the server refused the first with "Submitted content is not the saved draft" and the person saw a conflict error with a failed bubble. A durable send now holds the chat's draft slot from its save through its submit; autosaves and other sends wait their turn.
