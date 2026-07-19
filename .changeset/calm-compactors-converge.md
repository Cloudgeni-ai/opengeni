---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Make context compaction and pending tool-call recovery converge without reactivating superseded history or repeating failed internal turns.
