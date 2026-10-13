---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Record canonical Modal create intent before cold API provider dispatch, including qualified source, image and authenticated namespace. Attribute the exact operation before warming, and preserve unresolved creates and unknown setup starts for receipt recovery without replay or premature sandbox cleanup.
