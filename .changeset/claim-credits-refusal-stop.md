---
"@opengeni/worker-bundle": patch
---

A turn refused for lack of credits when it starts (no credits, API credits required, own-key paid credit required, or a host entitlements deny) now stops like a turn that runs out of credits midway: the session stays idle with the credits notice, instead of failing with "Activity task failed". This matters most when workers' messages wake a parent chat after its credits ran out; the parent no longer ends as failed, though each such wake is an empty stopped turn. Other fixed refusals at start (monthly limits, plan or subscription requirements) still fail the turn with their message.
