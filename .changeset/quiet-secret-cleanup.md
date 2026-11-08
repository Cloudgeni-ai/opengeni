---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Keep best-effort attempt-private secret-file deletion out of turn finalization. Clean each original recipient independently without resolving a new route or waiting for workspace capture, and retain mandatory run-credential cleanup and writer-drain guarantees.
