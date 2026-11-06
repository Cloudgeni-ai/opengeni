---
"@opengeni/contracts": patch
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

A turn that waits a long time for subscription capacity is no longer silent, and switching the chat's model or pausing it now releases the waiting turn.

A wait is long when its reset is at least 15 minutes away, unknown, or needs a person. When one starts, a worker's parent gets a `child_waiting_capacity` notice right away: it now carries `resetsAt`, names the provider correctly, says how to continue sooner (switch the worker's model with `session_set_model`), wakes the parent instead of waiting for its next turn, and the worker delivers it as soon as the wait is armed. A top-level chat's person gets an inbox notification with the reset time, withdrawn when the wait ends. Short waits stay quiet. `OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED` now defaults to on; every image since August 2026 understands these notices.

Switching a chat's model moves a turn that is waiting for capacity onto the new model in the same commit, and the turn continues there now (the `session_set_model` receipt reports `capacityWaitingTurnContinuesNow`). Pausing a chat stops its capacity-waiting turn: the wait is removed and the turn waits for Resume, or for a model switch, like a paused running turn. A workspace pause still keeps the wait for Resume.
