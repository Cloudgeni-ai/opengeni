---
"@opengeni/db": patch
---

Session-wide pending-writer and quiescence checks now evaluate only the attempts that can still hold a writer or await quiescence, instead of every attempt in the session's history. Long-lived sessions no longer pay per-attempt correlated subqueries on every queue peek, claim and recovery check.
