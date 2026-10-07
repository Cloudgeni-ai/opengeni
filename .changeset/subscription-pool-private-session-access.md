---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Keep private-session access when Claude and SuperGrok capacity handling runs
under the shared pool-worker database subject. Arming a capacity wait, the
workflow's work peek, periodic recovery, lease acquisition, session pins and
last-account metadata now re-establish the acting turn's frozen initiating
human, so a `user_private` session waits and resumes like a shared one.
Previously arming failed with "Session not found", the workflow peek treated
the waiting session as runnable, and recovery reported the waiter as stale so
the session never resumed. The pool worker still cannot see any other member's
private session. An immediate wake-up (for example after a member reconnects an
account) runs as that member and does not reach another member's private
waiter; that waiter resumes on its next periodic recheck, at most 60 seconds
later. A wait that cannot be armed for a non-database reason now fails the turn
with the explicit, retryable `<provider>_capacity_wait_unavailable` state.

No database migration or configuration change is required.
