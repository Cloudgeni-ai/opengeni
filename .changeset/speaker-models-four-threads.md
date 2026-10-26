---
"@opengeni/worker-bundle": patch
---

Speaker detection for meeting recordings runs on 4 threads by default
instead of every core. A half-hour meeting takes 128 CPU-seconds instead of
304 on a 32-thread machine and still finishes alongside its transcription.
Word alignment keeps using every core.
