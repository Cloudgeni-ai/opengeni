---
"@opengeni/worker-bundle": patch
---

A turn that is refused for lack of credits when it starts now stops like a turn that runs out of credits midway: the session stays idle with the credits notice, instead of failing with "Activity task failed". This matters most when workers' messages wake a parent chat after its credits ran out; the parent no longer ends as failed.
