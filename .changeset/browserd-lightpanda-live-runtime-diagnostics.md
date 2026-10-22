---
"@opengeni/browserd": patch
---

Lightpanda tabs report console messages and page errors again. Lightpanda does not replay earlier messages when Runtime is enabled, so its tabs keep Runtime enabled and record them as they happen; Chrome tabs still read them only when diagnostics are requested.
