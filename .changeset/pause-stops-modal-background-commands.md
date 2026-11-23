---
"@opengeni/runtime": patch
"@opengeni/db": patch
---

Pause, Cancel and Stop now end a long-running Modal sandbox command that had moved to the background. Previously it kept running until it exited on its own.
