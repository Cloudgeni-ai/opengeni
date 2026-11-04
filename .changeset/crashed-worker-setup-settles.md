---
"@opengeni/worker-bundle": patch
---

A chat no longer stays stuck when its worker crashes during shutdown while the sandbox is still being set up. Once the worker's shutdown exit deadline (about two minutes by default) has passed and Temporal shows the closed attempt's activity has settled, the unfinished setup step is settled, so the recovery, a waiting Steer or the next message runs within minutes. Pause, Steer and cancellation, a setup whose start outcome is recorded unknown, and model commands keep their existing protection.
