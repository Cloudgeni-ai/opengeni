---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Keep sandbox Toolspace and Code Mode available during unbounded turns by
proactively re-signing the session-bound delegated bearer and atomically
replacing its off-manifest token file on managed and connected-machine backends.
