---
"@opengeni/db": patch
---

Fix SuperGrok disconnect failing when sessions are pinned to the account. Clear
the credential pin and its source atomically, preserving stale-update fencing.
