---
"@opengeni/react": patch
---

Pausing active work shows "Current work stopping" as soon as the Pause is accepted, while the running command stops. The chip used to wait for the next queue refresh, so a quick stop could pass with no feedback at all. It now follows the Pause receipt until the session's control catches up, and the queue takes over from there.
