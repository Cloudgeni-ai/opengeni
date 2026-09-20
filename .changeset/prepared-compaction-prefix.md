---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Reuse the fully prepared model request for remote compaction, including sandbox instructions, filtered tools, and model settings. Prepare operator and pre-turn compaction through the same model boundary without sending ordinary inference. Capture compaction requests in model diagnostics.
