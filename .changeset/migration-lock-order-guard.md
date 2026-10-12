---
---

New `check:migration-lock-order` CI guard: a migration may no longer wait for an advisory lock after taking a table lock it holds until commit. That order inverts the one application transactions use and deadlocks with live traffic during a rolling deploy. Shipped migrations with this shape are frozen in a grandfathered list.
