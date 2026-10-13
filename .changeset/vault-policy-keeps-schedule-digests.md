---
"@opengeni/db": patch
---

Upgrading to vaults no longer changes the execution digest of every existing schedule. Migration 0739 added the schedule `vault_policy` column, and because a schedule's digest hashes its whole row, every stored digest stopped matching, so 0753 refused to run (`0753 cannot reproduce a stored scheduled-task execution digest`) on any database that had schedules. 0739 now leaves the default vault policy out of the digest (a narrowed policy still changes it, like any other execution change) and refuses to complete if any schedule digest that reproduced before it no longer does.
