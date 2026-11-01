---
"@opengeni/worker-bundle": patch
---

A session whose agent may not use secrets no longer tries to save secrets found in tool output into a Task vault it does not have; the values are masked with their marker from the start, without failing vault writes and warnings.
