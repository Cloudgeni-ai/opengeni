---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Resuming a browser whose earlier resume expired now continues it from its retained working copy instead of failing with an internal error. The continuation kept its controller authority alive by checking an operation that is only recorded after the controller adopts the working copy, so every such resume stopped before reaching the controller. It now checks the expired resume itself: the browser must still be lost from that resume and still be bound to the same controller generation.
