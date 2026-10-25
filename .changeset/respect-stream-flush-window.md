---
"@opengeni/worker-bundle": patch
"@opengeni/events": patch
---

Keep deltas arriving during a durable append inside their existing batching window. Flush only the requested queue prefix while preserving immediate first text, structural checkpoint durability, serialized writes and final draining.

Preserve ambiguous single-star reasoning boundaries in both write and read coalescing so batching does not change the rendered heading separators. Unflushed partial deltas can remain in memory until the existing window expires; their crash-time persistence cutoff is not identical to eager draining.
