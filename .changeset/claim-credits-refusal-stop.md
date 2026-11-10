---
"@opengeni/worker-bundle": patch
---

A turn refused for lack of credits or a paid plan when it starts (no credits, API credits required, own-key paid credit or Pro required, own subscription needing Pro, or a host entitlements deny) now stops like a turn that runs out of credits midway: the session stays idle with the credits or upgrade notice, instead of failing with "Activity task failed". This matters most when workers' messages wake a parent chat after its credits ran out; the parent no longer ends as failed, though each such wake is an empty stopped turn. Monthly limits and a connected subscription used for API work still fail the turn with their message at start.
