---
"@opengeni/runtime": patch
"@opengeni/db": patch
---

Bound concurrent per-file Git capture reads and stop queued reads after failure or cancellation. Avoid recounting the background-command backlog during each command settlement, keeping large backlogs from blocking session control.
