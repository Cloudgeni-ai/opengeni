---
"@opengeni/db": patch
---

Session lists no longer slow down as interruption history grows. The "stopping" summaries for interrupted attempts and stopping background commands now start from the small set of still-open work (a new partial index on interruptions, kept exact by a trigger-maintained quiescence hint) and walk up to the requested sessions, instead of scanning every interruption in the workspace or walking every requested subtree.
