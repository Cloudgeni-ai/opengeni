---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Background commands that finish quickly but print a lot of output are now recognized as finished within seconds instead of staying "running" for hours. Their sandbox can then save its workspace and go idle normally, instead of being held until the provider's 24-hour limit ends it. Each stream records up to 16 MiB of a command's output, with a note when the rest was not recorded.
