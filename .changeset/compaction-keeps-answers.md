---
"@opengeni/runtime": patch
---

After history is compacted, a request the agent already answered keeps a short copy of that answer, so the agent no longer mistakes it for a pending request and answers it again.
