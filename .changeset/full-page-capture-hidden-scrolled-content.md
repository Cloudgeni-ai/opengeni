---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/contracts": patch
"@opengeni/api-router": patch
---

A full-page browser screenshot now says when it leaves out content that scrolls inside the page's own areas (an app's main pane or a table), and by how many CSS pixels, with how to capture the rest. It is also exactly as wide as the viewport when the page hides content past its right edge, instead of widening to content no one can scroll to.
