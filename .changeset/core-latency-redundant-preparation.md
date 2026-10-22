---
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Avoid unused Skill preparation for turns with Skills disabled or no bundled Skills selected, reuse caller-scoped metadata within full-detail session MCP reads, and repair stranded reasoning runs in one pass. Existing tool selection, live authority checks, model inputs and recoverable tool-call pairing remain unchanged.
