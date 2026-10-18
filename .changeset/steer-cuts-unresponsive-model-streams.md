---
"@opengeni/runtime": patch
---

A Steer now cuts the in-flight model answer within 200 ms even when the model transport ignores the abort signal or is stalled between events. Before, the handover waited until such a stream ended on its own, so a Steer could take as long as the rest of the answer. The cut-off answer is kept exactly as before.
