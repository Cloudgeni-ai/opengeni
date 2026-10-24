---
"@opengeni/db": patch
---

Migration 0950 grants the runtime role EXECUTE on the recording retention inventory that 0946 withheld for one release. Readiness and provisioning now require it, so workspaces' recording retention periods are applied instead of the sweep skipping its pass.
