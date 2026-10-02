---
"@opengeni/browserd": patch
---

Separate desktop backend operations from OpenGeni's session controller and viewer. The native helper retains its existing transport and behavior; alternative desktop drivers can reuse the same receipts, media delivery and access boundary.
