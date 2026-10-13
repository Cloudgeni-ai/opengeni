---
"@opengeni/db": patch
---

Queue-row Steer now clears a previous admission block just like Send, ordinary Steer and Resume. Repair unchanged historical queue Steer requests that left their old block in place, retaining a durable workflow wake until admission. Paused recoveries and subscription capacity waits remain resumable and are not cancelled based on age.
