---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Preserve structured model-history ordering through PostgreSQL replay and pending-tool recovery. Retain authorized uploaded images across turns and compaction input, preserve images in retained messages, and include their projected token cost in compaction retention budgets. Migration requires draining writers.
