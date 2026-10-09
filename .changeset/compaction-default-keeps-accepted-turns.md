---
"@opengeni/config": patch
---

Changing a model's default compaction threshold no longer fails turns that were already running. These turns resumed after a deployment and then stopped with "Turn execution policy does not match the current provider definition". The compaction threshold is no longer part of a model's frozen definition, and turns accepted before this change keep running.
