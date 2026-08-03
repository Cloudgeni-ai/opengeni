---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Add an atomic terminal session-subtree cancellation command that drains queued work, fences concurrent prompts and child creation, interrupts live attempts, durably reports cancelled children to surviving parents, and exposes the operation through the API/core/SDK control surface.
