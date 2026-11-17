---
"@opengeni/runtime": patch
---

Context compaction keeps the tools the agent is using loaded. Tools it loaded through tool search (or a browser or computer entry tool) and then called, or loaded right before the checkpoint, are declared again after the checkpoint with the definitions it already saw, so the agent no longer searches for them again. Tools loaded and never used are still dropped.
