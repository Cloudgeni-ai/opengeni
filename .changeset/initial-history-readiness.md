---
"@opengeni/react": patch
---

Expose successful initial history readiness independently of loading and stream
errors, including empty histories. Clear stale initial-load errors on fenced retry
and successful window recovery without letting old sessions overwrite new state.