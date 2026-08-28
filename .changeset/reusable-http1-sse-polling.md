---
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Deliver browser HTTP/1 events as immediate, vendor-typed snapshots read from the durable event store, without opening a timed live subscription or closing the reusable socket. Preserve cursor-based replay while preventing replaced documents from starving ordinary API reads across tabs and account changes.
