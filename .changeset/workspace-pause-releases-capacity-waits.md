---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

Pausing the whole workspace now stops turns waiting for subscription capacity, as a chat's Pause already did: the wait is released, the "continues by itself" notification is withdrawn, and Resume continues the turn, announcing the wait again if capacity is still missing.
