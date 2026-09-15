---
"@opengeni/worker-bundle": patch
---

Continue completed Connected Machine command output replay across partial batches using one integrity checkpoint, instead of repeatedly restarting before the terminal frame. Preserve capture failures, no-progress deferral, exact operation identity, and verified terminal settlement.