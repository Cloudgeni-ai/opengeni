---
"@opengeni/db": patch
---

Keep the retry writer's activity-gated transaction explicit at the canonical
writer boundary while binding its required recovery-route check through root
composition. Preserve the writer audit and retry safety checks unchanged.