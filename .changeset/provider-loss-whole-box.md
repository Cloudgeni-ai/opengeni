---
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

When a sandbox is gone, all of its background commands now settle at once. The reaper used to settle each retained command only after its own provider probe, at most 20 per 30-second sweep, so a box with 35 commands that Modal had already ended took 11 more minutes to clear while the session waited. The first probe that finds the exact current box missing now retires the whole box in one transaction: every command, open request, terminal and process holder is settled, the lease goes cold, and a turn waiting on the box is woken. Commands lost with their sandbox now tell the agent "`cmd` stopped because its sandbox was shut down or lost; its exit status is unknown. Restart it if you still need it." instead of "result unavailable", and the session's Incoming panel shows several pending command results as one row with a single dismiss action.
