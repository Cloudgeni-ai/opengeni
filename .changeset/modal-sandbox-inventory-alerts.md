---
"@opengeni/runtime": patch
---

The Modal orphan sweep now reports what it reconciled: running Modal boxes, boxes running without a live lease, and live leases whose box is gone. The worker publishes these as `opengeni_modal_sandbox_inventory{state}`, and Modal deployments alert when unleased boxes or lease-less instances persist for 15 minutes, or when the sweep stops completing a full listing.
