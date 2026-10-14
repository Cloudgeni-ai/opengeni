---
"@opengeni/db": patch
---

Creating many tasks in one database statement no longer slows down quadratically. Per-task usage-limit counters are now seeded once per insert statement instead of once per row, so bulk inserts such as imports cost the same per task as single inserts.
