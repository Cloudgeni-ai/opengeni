---
"@opengeni/browserd": patch
---

A tab opened after the agent sets a viewport now gets that size, as it would from a resized window, so the agent no longer has to set it again on every new tab. Tabs that were already open keep their own size, and each tab keeps its size when it is attached again.
