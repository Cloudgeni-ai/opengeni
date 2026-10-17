---
"@opengeni/db": patch
---

Reads of many rows from one session no longer scan every session in the workspace to check visibility. The session visibility check on session child tables could be planned as a hashed scan of all visible sessions, costing tens of milliseconds per statement on a busy workspace; it now always probes the session by key for the rows actually read.
