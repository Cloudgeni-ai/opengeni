---
"@opengeni/worker-bundle": patch
---

Keep a turn active when its post-compaction continuation ends without a terminal model response, recovering from the durable compacted checkpoint instead of emitting an empty completion and advancing queued prompts.