---
"@opengeni/db": patch
---

Repair user-owned device approval under a FORCE-RLS non-bypass database owner.
Fence organization membership before tenancy and request locks, retain workspace
membership row locks, and reject contention without a reverse-order wait.
Requires the 0498 maintenance cutover; broader scoped-compute readers are not
changed by this bounded enrollment repair.