---
"@opengeni/db": patch
---

Reduce session-list totals work by joining each node's static personal state before the recursive walk and carrying it through aggregation. Preserve visibility, pinned paths, unread state and attention counts while avoiding repeated joins and unnecessary duplicate elimination.
