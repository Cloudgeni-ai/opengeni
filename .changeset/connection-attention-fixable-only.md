---
"@opengeni/react": patch
---

`connectionOptionNeedsAttention` and `attentionFirst` now treat only connections that report attention (reconnect, failed health check) as needing attention. A connected but unavailable entry, such as one with restricted access, is something the person can't fix there, so it keeps its place instead of moving to the top.
