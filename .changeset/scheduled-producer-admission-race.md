---
"@opengeni/worker-bundle": patch
---

Re-read scheduled-task execution and authority after a concurrent task-head change rejects fresh producer admission, so simultaneous cold reusable runs converge without waiting for an activity retry. Preserve the exact database authority fence and accepted-producer replay.
