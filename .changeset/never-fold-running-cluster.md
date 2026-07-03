---
"@opengeni/react": patch
---

A cluster containing a running or streaming item can never fold — the live-cluster fold rule was position-based ("not the last group"), which wrongly folded the actively-streaming cluster when a pending queued message rendered at the timeline tail.
