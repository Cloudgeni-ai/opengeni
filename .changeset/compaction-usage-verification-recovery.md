---
"@opengeni/worker-bundle": patch
---

A context checkpoint request that the included-usage policy refuses before dispatch (usage exhausted or temporarily unverifiable) now recovers the same turn like the same refusal on an ordinary request, instead of failing the turn and leaving the chat idle.
