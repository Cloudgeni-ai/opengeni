---
"@opengeni/runtime": patch
---

A chat switched to Claude from a model that ran a tool search in the middle of a tool step no longer fails every turn with "Claude tool calls require results before another assistant message". A system message that sits inside an unfinished tool step, with more of the reply after it, now goes just after that step's results. When the results come right after it, it keeps its place as before, so every history Claude already accepted is sent unchanged.
