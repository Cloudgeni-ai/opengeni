---
"@opengeni/worker-bundle": patch
---

Sending SIGUSR2 to a worker for a CPU profile no longer drains it. The Temporal SDK also treats SIGUSR2 as a shutdown signal by default, so a profiling request stopped the worker from taking new work and restarted it. The worker now registers only SIGINT, SIGTERM and SIGQUIT with the SDK.
