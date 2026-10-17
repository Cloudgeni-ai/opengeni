---
"@opengeni/db": patch
---

Reading a session's effective model policy stays a single newest-first index probe under a generic prepared-statement plan. The started-turn check is now a scalar subquery the planner cannot flatten into a join; before, a generic plan could scan and sort every turn of the session, which took tens of milliseconds to seconds on a long session and slowed every session read.
