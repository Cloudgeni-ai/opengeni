---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Preempt sandbox writers and persistent interaction holders at the provider-deadline rotation lead boundary so the zero-holder reaper can capture the exact workspace generation before provider destruction.