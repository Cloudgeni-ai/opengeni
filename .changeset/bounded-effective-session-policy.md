---
"@opengeni/db": patch
---

Resolving a session's effective model, reasoning effort and latency mode no longer reads the session's whole history. Every session read joined all `turn.started` events to all turns and sorted them, so a long session cost thousands of buffer reads per read, and after a model-settings change the read walked every older start looking for an eligible turn. The lookup now walks start events newest-first, probes each turn by primary key, stops at the first eligible turn and never walks past the latest settings change, also under row-level security. Results are unchanged (verified against every session of a production-sized database).
