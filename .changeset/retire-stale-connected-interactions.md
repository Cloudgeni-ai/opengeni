---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

Retire Browser and Desktop resources when their source task leaves the Connected Machine that owns their controller, stop retrying the terminal placement conflict, and let Desktop create one replacement on the task's current placement.
