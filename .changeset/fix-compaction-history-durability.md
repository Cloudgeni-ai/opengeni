---
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/contracts": patch
---

Preserve externally managed history across opaque compaction checkpoints and verify conversation persistence before continuation. Reject shifted history prefixes and conflicting saved items instead of silently losing completed work.
