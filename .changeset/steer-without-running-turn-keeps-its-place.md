---
"@opengeni/react": patch
---

A message sent as a Steer while no turn was running now stays above the turn it starts. When a later Steer handed that turn over at its next model step, the timeline moved the turn's work and messages above the first message, so the person's question read as if it came after its own answer, both live and after a refresh. Only Steers drawn while a turn is actually running now wait for that turn's handover.
