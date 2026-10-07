---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Keep private-session access when Claude and SuperGrok capacity handling runs
under the shared pool-worker database subject. The capacity-waiter lookup, the
workflow's work peek, lease acquisition, session pins and last-account metadata
now re-establish the acting turn's frozen initiating human, so a `user_private`
session waits and resumes like a shared one; arming and reconciling a shared
pool's wait already run without a subject. Previously the workflow peek treated
a waiting private session as runnable and the capacity workflow could not find
its waiter. The pool worker still cannot see any other member's private session,
and an ambient actor is never combined with another member's human. An
immediate wake-up after a member reconnects an account or changes a shared pool
now reaches every waiter of that exact pool, including other members' private
waiters, without giving that member access to them; it previously waited up to
60 seconds for the periodic recheck. A wait that cannot be armed for a
non-database reason now fails the turn with the explicit, retryable
`<provider>_capacity_wait_unavailable` state.

No database migration or configuration change is required.
