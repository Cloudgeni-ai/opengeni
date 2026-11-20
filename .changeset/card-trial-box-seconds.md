---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

While the card verification gate is on, a new Free or plan-less organization's agent can use a sandbox for 10 minutes (`cardTrialBoxSeconds`, one box at a time) before an owner must add a card. Terminals, desktops, viewers and background processes still need the card, and the reaper drains leftover boxes once the trial is used.
