---
"@opengeni/db": patch
---

Subscription runtime capability rows no longer leak when a database connection closes. Each grant now also removes a few rows left by transactions that have already ended, in any connection, without waiting on other grants. The migration empties the table once, after every transaction that could hold a grant has finished, which also releases its accumulated storage.
