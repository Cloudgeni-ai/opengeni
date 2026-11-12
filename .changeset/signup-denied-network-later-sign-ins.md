---
"@opengeni/db": patch
---

The denied network rule (`denied-network-v1`) now also matches a new owner's sign-ins after organization setup. Farms set up from a fresh address and sign in from a denied network a minute later; that sign-in was never recorded, so the account kept its Free credit. Each evaluation within seven days of setup now records the owner's newer sign-ins first (one indexed look-up; writes only when there is a newer sign-in) and then matches as before. Exact networks only, owners only, keyed hashes only, manual decisions and operator releases kept, and failures fail open.
