---
"@opengeni/contracts": patch
---

The prompt-cache warm-miss classifier now classes a call whose history's first item changed as `context_replaced`. On Claude a compacted history's leading system items join the system prompt, so the first call after compaction was reported as `system_changed` and counted toward the prefix-changed alert whenever the item count stayed above 60% of the previous call, or when the previous call was the shorter compaction request itself. A system change that keeps the first history item is still `system_changed`.
