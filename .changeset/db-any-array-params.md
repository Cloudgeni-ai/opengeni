---
"@opengeni/db": patch
---

Session list, policy, wait, tree-stats, control-plane and content-blob reads now bind their variable id lists as one array parameter (`= any($n::uuid[])`) instead of one parameter per id. Each list length used to be a distinct statement text that every database connection planned from scratch, which made planning a large share of database CPU; one statement per query now keeps a single reusable plan for any list length.
