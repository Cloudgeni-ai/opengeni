---
"@opengeni/db": patch
"@opengeni/core": patch
---

Overlapping syncs of one connected vault now replace its mirror one at a time. The mirror replacement takes the vault row lock before it reads the mirror, so an older listing can no longer re-add an item that a newer one removed while the newer content version is recorded, which also stopped later unchanged syncs from repairing it.

A reference that finds nothing now refreshes every connected vault that could change the answer: those at or above the priority tier that matched. A hosted workspace item without a one-time password no longer stops a stale Only-me connected vault from being refreshed, so `Item/otp` resolves once that provider has the one-time password, or reports the provider as unavailable, rate limited or needing reconnection instead of asking for the secret. A lower-priority connected vault that is down no longer turns a miss decided by a higher tier into an unchecked one.
