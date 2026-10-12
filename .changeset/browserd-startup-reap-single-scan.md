---
"@opengeni/browserd": patch
---

Startup reaping of stale browser sessions now reads the Linux process inventory once per pass and fully identity-checks only processes that name the exact profile, so a machine with many retained session directories no longer exceeds the browser sidecar readiness timeout.
