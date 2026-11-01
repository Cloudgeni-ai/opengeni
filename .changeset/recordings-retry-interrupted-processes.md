---
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

A meeting or dictation whose processing is cut off by the worker stopping (a deploy or a lost pod) is retried on another worker instead of failing. ffmpeg or the speaker models killed by a signal, ffmpeg's "received signal" exit, and Temporal's shutdown cancellation are now interruptions, not invalid audio, and an interrupted speaker detection no longer silently falls back to the model's speakers.
