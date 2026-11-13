---
"@opengeni/db": patch
---

Session event pages stay fast on PostgreSQL 16.16, 17.12 and 18.7. On those releases the planner can scan the payload before joining the ordered ID list, so the byte-sized page prefix rescanned the whole session at every step instead of looking up the next event by ID; large pages slowed down quadratically. The next ID is now read through a subquery, which keeps it an index lookup on every PostgreSQL version.
