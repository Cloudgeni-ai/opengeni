---
"@opengeni/db": patch
---

Stop the recovery wake reaper from rediscovering paused-mid-turn sessions forever. Discovery now omits quiesced recovering turns parked behind Pause, an admission block or a sandbox setup marker, whose own unblocking action commits a wake, and the repair now parks a paused session whose projection was left at `recovering`.
