---
"@opengeni/db": patch
"@opengeni/config": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Prepare the first phase of bounded rig-verifier ownership: add the tenant-consistent owner registry/API, teach Modal orphan sweeps to recognize active exact verifier owners, and parse a strict default-off activation setting. Verifier owner creation remains intentionally absent until every shared-queue worker has deployed this owner-aware reaper.
