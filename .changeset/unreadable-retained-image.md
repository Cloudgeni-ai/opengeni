---
"@opengeni/storage": patch
---

`getObjectBytes` on S3-compatible and Azure storage now throws `ObjectBodyIncompleteError` when the object was found but its body failed or ended short of the declared length, so callers can tell lost object data apart from an unreachable store. The worker uses it for retained screenshots: an image whose bytes never arrive intact on repeated reads is treated as no longer retained and shown to the model as the existing neutral receipt, instead of failing every later turn of the chat. Other storage failures while loading history images now fail the turn as `retained_attachment_unavailable` (retried with connectivity backoff) rather than being reported as the model provider being unavailable.
