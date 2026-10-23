---
"@opengeni/db": patch
---

Add a scope-aligned ordered history index so prepared receipt-page reads avoid intersecting a full-session index with the current turn. History, authorization and cursor behavior are unchanged.
