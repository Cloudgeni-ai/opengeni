---
"@opengeni/worker-bundle": patch
---

Turns on an owned sandbox start the model sooner. Repository clones, rig setup and credential hooks now run alongside file delivery and model-input preparation instead of after them, and the first model request waits only for whichever finishes last. What the model sees, and its order, is unchanged.
