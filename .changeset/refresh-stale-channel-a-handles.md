---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/observability": patch
"@opengeni/runtime": patch
---

Isolate read handles from process-capable handles, replace Modal's transport in place when its command-router URL rotates, rebuild the exact lease-fenced handle once for side-effect-free reads after a typed provider outage, and correlate handle recovery safely across API and reaper logs.
