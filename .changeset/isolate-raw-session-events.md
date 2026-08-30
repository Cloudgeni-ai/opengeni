---
"@opengeni/db": patch
---

Make the narrow session-event cursor authoritative for public sequence and unread projections, and isolate accepted raw exact-attempt batches from the wide session-row lock while preserving legacy SQL writer compatibility.