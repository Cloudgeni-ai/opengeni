---
"@opengeni/db": patch
---

Make storing archived chats cheaper for the database: deleting a stored chat's model history and machine inputs now checks the rows that reference them with an index seek instead of scanning every workspace's delivered updates for each deleted row.
