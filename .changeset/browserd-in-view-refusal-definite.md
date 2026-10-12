---
"@opengeni/browserd": patch
---

A click or hover on a target that is already in view, but covered or without a box, is now a definite refusal instead of an unknown outcome. Refusals after an actual scroll stay unknown, because scrolling can run page handlers.
