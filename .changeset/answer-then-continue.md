---
"@opengeni/runtime": patch
---

A question or status message that arrives while earlier work is unfinished no longer stops that work. The agent answers it, then continues the unfinished work it can still advance in that turn, unless the message changes or cancels it. Before, the instructions said to answer "without starting or resuming other work", so a request whose turn had been replaced by a newer message was dropped for good.
