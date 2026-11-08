---
"@opengeni/core": patch
"@opengeni/db": patch
---

Reduce chat-open database work by reusing bounded request authorization and catalog inputs, activating read-only external identity lookup, and avoiding redundant session and voice projections. Fresh stream authorization and write-path fences remain live.
