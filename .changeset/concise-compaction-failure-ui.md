---
"@opengeni/react": patch
---

A failed context compaction now appears once, on its timeline landmark: "Couldn’t compact conversation history" with one short recovery step and a single Details control (the provider response, rejected parameter and request ID, or the recorded error text when there is no provider rejection). The failed turn chip names the outcome instead of the raw provider text, no separate notice repeats the failure, and the landmark no longer overflows the timeline. `ContextCompactionItem` gains an optional `failureDetail` with the same turn's recorded failure text.
