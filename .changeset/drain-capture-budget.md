---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

An idle sandbox drain no longer piles up workspace captures. A host-backed capture that outlives the drain snapshot budget now stops, removes its temporary spool and releases its claim, including during the archive re-read and verification passes. A retry no longer starts a second capture of the same box while an earlier one is still settling in that worker. Provider-native captures still publish late. A workspace that needs more time to drain should get a larger `OPENGENI_SANDBOX_DRAIN_SNAPSHOT_TIMEOUT_MS`.
