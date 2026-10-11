---
"@opengeni/db": patch
---

Waking subscription capacity waiters no longer deadlocks. A wake now takes each session's lock before its waiter's, the same order a resume uses, so concurrent wakes of one pool and a wake racing a resume no longer abort with deadlock errors.
