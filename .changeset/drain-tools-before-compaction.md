---
"@opengeni/runtime": patch
"@opengeni/worker": patch
---

Drain completed tool events before context compaction so successful tools do not remain unfinished in the chat timeline.
