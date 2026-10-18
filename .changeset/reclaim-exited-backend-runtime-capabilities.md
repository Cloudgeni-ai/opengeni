---
"@opengeni/db": patch
---

Subscription runtime capability rows no longer leak when a database connection closes. Each grant now also removes a few rows left by transactions that have already ended, in any connection, without waiting on other grants. The migration empties the table once, which also releases its accumulated storage; when the table stays busy it deletes the finished rows instead, so a busy database never fails the deploy.
