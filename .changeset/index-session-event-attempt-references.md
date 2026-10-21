---
"@opengeni/db": patch
---

Index non-null session-event attempt references so deleting a settled chat no longer scans unrelated workspace events for every historical attempt. The existing restrictive foreign key and tenant boundaries stay unchanged; the index builds concurrently.
