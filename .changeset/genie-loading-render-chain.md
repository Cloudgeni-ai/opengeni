---
"@opengeni/react": patch
---

The startup loading animation no longer re-renders in a burst after every update to the conversation around it. Its rotating phrase was re-picked on every render, and each new pick caused another render until the random choice happened to repeat. The phrase now changes only on its five-second timer.
