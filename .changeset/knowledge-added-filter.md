---
"@opengeni/contracts": patch
"@opengeni/db": patch
---

Knowledge listing and search accept an optional `createdSince` timestamp to find newly added entries by their original creation date. Rolling migration 0640 applies the filter before ranking and pagination without changing access. The Knowledge Library offers Added filters for the last 24 hours, 7 days, and 30 days.
