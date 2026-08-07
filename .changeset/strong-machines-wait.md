---
"@opengeni/config": patch
"@opengeni/runtime": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Make Connected Machine command duration unbounded by default over replayable op-stream execution, preserve explicit positive deadlines for constrained deployments, wire and finalize streaming across direct and swapped machine routes, remove the generated service's aggregate memory throttle while retaining accounting and OOM isolation, and bound transient reordering memory by bytes without limiting command resources or output.
