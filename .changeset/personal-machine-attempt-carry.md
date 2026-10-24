---
"@opengeni/db": patch
---

Migration 0948 lets a turn that an agent moved to another of its owner's personal machines continue in a replacement attempt. The new attempt re-proves the same turn's earlier machine authorization against the current owner, machine and grant, instead of failing admission on a missing snapshot row. A machine the turn was never authorized for, or whose grant was revoked, now refuses with the typed grant-required cause instead of an unmapped database error.
