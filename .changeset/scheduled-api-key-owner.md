---
"@opengeni/core": patch
"@opengeni/db": patch
---

Scheduled tasks created by an organization or workspace API key (or the
configured key) are now ownerless service schedules and run. Previously the
key subject became the schedule's immutable owner, and every occurrence failed
invisibly in the scheduler. An occurrence refused because its frozen authority
cannot be proven is now recorded as a failed run with error
`scheduled_authority_unavailable` instead of being retried to exhaustion with
no run. Schedules already owned by a key keep being refused visibly; the same
key can still pause, edit, or delete them, and recreating them makes them run.
