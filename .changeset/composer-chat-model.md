---
"@opengeni/db": patch
---

Persist submitted composer model, reasoning and latency choices as the chat's defaults, including for subsequent scheduled and automatic turns. Apply the choice atomically with Send or Steer without changing already accepted turns or reapplying old choices on retry.
