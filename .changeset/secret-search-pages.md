---
"@opengeni/contracts": patch
"@opengeni/core": patch
---

Agents can page through every secret they can use. `secret_search` returns a `nextCursor` to continue the same search, lists each reachable vault with its item count on the first page, and checks websites across a whole vault instead of only its first 50 items.
