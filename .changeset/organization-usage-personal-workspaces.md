---
"@opengeni/contracts": minor
"@opengeni/db": minor
---

Organization usage summaries now list each member's Personal workspace as a
usage-only row (`personalWorkspaces`, keyed by the owner's organization
membership, plus `personalWorkspaceCount`). Rows carry amounts only - never the
Personal workspace id, name, sessions or content - and follow the same
actor-visible session rule as the period totals, which already counted this
usage. Rolling migration 0543 replaces the aggregate with the same signature and
ACL, so older API processes keep working and ignore the new fields, which
default to empty.
