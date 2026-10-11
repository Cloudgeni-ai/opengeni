---
"@opengeni/db": minor
"@opengeni/events": patch
---

Fold streamed text deltas after their turn settles. Session storage maintenance replaces each run of adjacent `agent.message.delta` or `agent.reasoning.delta` rows with its first row carrying the whole text, `coalescedUntil`, and a lossless `folded` record of every original fragment; `unfoldSessionEventDeltas` rebuilds the originals. Delta coalescing honors a stored `coalescedUntil` as coverage. Content compaction now keeps working through its backlog within a pass while it makes progress.
