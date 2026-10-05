---
"@opengeni/react": patch
---

`useGoal` no longer refetches (and 404s) the goal on every turn and session event while the session has no goal; only goal events can create one.
