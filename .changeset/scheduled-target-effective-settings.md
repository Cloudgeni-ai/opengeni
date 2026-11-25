---
"@opengeni/db": patch
---

Fix automation admission into an existing chat after its model settings change. The database now validates the same effective model, reasoning effort and latency mode the worker reads, without waiting for another turn.
