---
"@opengeni/sdk": patch
"@opengeni/contracts": patch
---

A scheduled task whose model was retired or removed from the catalog now records each
occurrence as a visible failed run with reason `scheduled_model_unavailable` instead of
failing the scheduler activity and leaving no run.
