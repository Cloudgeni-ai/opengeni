---
"@opengeni/db": patch
---

Approval run states are checked against their size limits in one linear pass in the worker before any database work, on save and on read. The database no longer counts their JSON nodes with `jsonb_path_query`, which took quadratic time: a run state with a few hundred thousand array elements cost seconds to minutes of database CPU, partly while the session row was locked.
