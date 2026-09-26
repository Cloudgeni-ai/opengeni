---
"@opengeni/react": patch
"@opengeni/runtime": patch
---

Bind browser viewer input to the frame actually painted, cancel stale queued input
across navigation and target changes, and preserve ordered scroll input. Treat
plain upstream gateway failures as transport errors without blindly replaying
browser mutations.
