---
"@opengeni/worker-bundle": patch
---

Keep deltas arriving during a durable append inside their existing batching window. Flush only the requested queue prefix while preserving immediate first text, structural checkpoint durability, serialized writes and final draining.
