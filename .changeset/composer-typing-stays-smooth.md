---
"@opengeni/react": patch
---

Typing in a long conversation no longer waits for the conversation to render. The composer draws each keystroke itself and the conversation catches up in an interruptible transition, and wide chat tables measure again only when their column or cells change, not on every render. Tables no longer force a layout on every keystroke or streamed event.
