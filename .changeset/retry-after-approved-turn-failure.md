---
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
---

Retry of a failed turn that was resumed by an approval or a human-input answer now continues from the conversation, where the decided tool call and its result already are, instead of failing with "Open suffix resume has no interruption rows".
