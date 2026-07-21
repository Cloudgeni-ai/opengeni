---
"@opengeni/db": patch
"@opengeni/config": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Prepare the first phase of bounded rig-verifier ownership: add the tenant-consistent owner registry/API, teach Modal orphan sweeps to recognize active exact verifier owners, and parse a strict default-off activation setting. The app role receives tenant-scoped read access but no direct registry mutation; pinned tenant-fenced functions own register/rebind and exact deactivation even after repeated role provisioning. The reaper treats its initial ownership projection only as a classifier, revalidates each termination candidate by exact current provider instance immediately before destruction, and fails closed when that authority is unavailable or inconsistent. Fresh stale-tagged and unattributed instances retain the common two-minute create/registration grace, while older wrong, expired, stale, and unattributed instances remain collectible; provider tags stay diagnostic only. Verifier owner creation remains intentionally absent until every shared-queue worker has deployed this owner-aware reaper.
