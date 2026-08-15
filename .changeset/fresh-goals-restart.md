---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Allow agent `goal_set` to replace completed goals while continuing to protect
active and paused goal intent. Preserve the legacy goal-revision list while
adding bounded pagination, governed rewrite decisions, accepted-turn root
constraints, and an explicit custom-runtime drain fence for the maintenance
cutover.
