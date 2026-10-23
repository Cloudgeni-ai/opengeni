---
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

After history is compacted, a request the agent already answered keeps a short copy of that answer, so the agent no longer mistakes it for a pending request and answers it again. Answers are matched by the turn that wrote them, so a request in the turn still running stays open, and repeated compactions keep each request with its own answer.
