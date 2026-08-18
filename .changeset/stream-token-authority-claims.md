---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
---

Scoped stream tokens (`ogs_`, 120 s TTL unchanged) now carry the authenticated viewer subject and the session's live authority epoch (migration 0281). The viewer lease holder records the same pair monotonically, the API re-verifies a human viewer's current workspace membership at every mint and degrades the stream to `transport:null` when membership is gone, and the selfhosted relay fences an attach whose authority claim is below the channel's recorded floor. Pre-0281 tokens keep working during the rolling window and enforce nothing new.
