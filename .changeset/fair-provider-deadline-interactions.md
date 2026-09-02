---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Keep provider-deadline interaction cleanup visible under FORCE RLS for lease-free controllers, prevent unrelated overdue leases from starving the bounded deadline batch, and clean already-draining Modal leases at their deadline.