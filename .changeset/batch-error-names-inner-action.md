---
"@opengeni/runtime": patch
---

An invalid action inside a browser or Desktop batch is now reported at its own field (for example `action.actions.1.deltaX`) instead of claiming the batch's `type`, `actions` and `fenceEachAction` fields are wrong.
