---
"@opengeni/db": patch
---

A parent no longer repeats its final answer when a child's result arrives after the parent already read it in a turn that was recovered from an interrupted attempt. The worker now tells the first-party server the model's call id for each direct tool call, the read record keeps it, and the turn's completion counts the read when its durable history holds that call's output.
