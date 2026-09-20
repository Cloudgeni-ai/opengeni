---
"@opengeni/db": patch
---

Preserve a warm snapshot's sole turn holder through its original bounded capture
deadline, even after logical turn closure. Reaper sweeps must not steal a live
finalizer's snapshot and extend interactive waiting with the drain capture budget.
Expired claims remain recoverable, and closed attempts gain no execution authority.