---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

An idle sandbox now drains even when an API request (Files, Terminal, Browser and similar) died mid-operation and left its request open. Before, the holder reaper removed the dead request's holder but kept its request, and that request refused every capture of the box: Modal boxes ran until the provider deadline, and Docker boxes stayed draining forever. Docker drains also capture requests left by a crashed turn worker now: the drain removes the exact container before it reads the host workspace, so the capture is a point-in-time image, as Modal snapshots already are.
