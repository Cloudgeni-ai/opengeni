---
"@opengeni/browserd": patch
---

A CUA `run_steps` batch that ran nothing now reports a plain failure instead of an operation of unknown outcome. When CUA rejects the batch while planning it, or stops at the first step before its action (the named target was not found, a `wait_for` check did not hold, or the batch ran out of time), nothing reached the app, so the model is no longer told not to replay it. A missing target reports `locator_not_found`. A batch that stopped after an earlier step ran, or in a step's action or `expect` phase, still reports an unknown outcome.
