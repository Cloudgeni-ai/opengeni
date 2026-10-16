---
"@opengeni/db": patch
---

Streamed text deltas are now merged when they are written instead of folded afterwards. The turn writer flushes model fragments at most 100 ms apart and stores each flush's adjacent plain text fragments as one `session_events` row, so a stream writes about a fifth of the rows it used to and nothing is deleted later. The settled-turn folding pass and its `foldSessionTurnDeltas`, `listSessionDeltaFoldCandidates` and `unfoldSessionEventDeltas` helpers are removed; rows folded by earlier versions stay readable through `coalescedUntil`.
