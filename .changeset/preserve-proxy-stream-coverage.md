---
"@opengeni/sdk": patch
---

Preserve compact session-event coverage when re-streaming through the SDK proxy helpers so downstream gap recovery does not replay already-covered deltas.