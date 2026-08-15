---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Freeze bounded, content-free Company Brain context selections once per accepted
logical turn so replacement attempts reuse the original workspace Memory
candidates and current authorization can only shrink recovery context.
