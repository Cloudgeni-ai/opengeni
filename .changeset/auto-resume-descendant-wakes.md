---
"@opengeni/db": patch
---

A Send or Steer that automatically resumes a paused branch now wakes the branch's waiting sub-sessions, as an explicit Resume does. Before, only the steered session got a wake, so a paused sub-session waiting on capacity, a parked recovery, an active goal, pending updates or a decided approval stayed stuck after the branch was resumed.
