---
"@opengeni/db": minor
---

Workspace-membership removal is now one fenced SECURITY DEFINER teardown (migration 0278): the removed member's queued/live turns in that workspace are cancelled, live attempts interrupted, realtime modes ended, private-session authority epochs advanced, workflow wakes registered, and per-workspace personal rows plus the membership deleted in one transaction. Self-removal, last-admin removal, and non-administering actors fail closed in the database seam.
