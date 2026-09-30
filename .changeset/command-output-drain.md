---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
---

Background commands that finish quickly but print a lot of output are now recognized as finished on the next background check instead of staying "running" for hours. Their sandbox can then save its workspace and go idle normally, instead of being held until the provider's 24-hour limit ends it. A command's saved output keeps its first 16 MiB and its final part, with a note where output was skipped.
