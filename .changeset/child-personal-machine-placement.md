---
"@opengeni/core": patch
---

A child an agent creates no longer copies its parent's personal (Only me) Connected Machine route. The owner approved that machine for the parent chat only, so the child's first turn was refused at admission and the child stopped with an unexplained database error. The child now runs on its group's own sandbox; a deployment with no managed sandbox refuses the create with a 422 that names the personal machine.
