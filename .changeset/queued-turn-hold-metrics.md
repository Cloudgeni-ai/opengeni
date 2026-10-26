---
"@opengeni/db": minor
"@opengeni/worker-bundle": minor
---

The control worker now reports why durable queued turns are not running. `opengeni_turns_queued_by_hold{hold}` splits the existing `opengeni_turns_queued` total into `ready` (waiting for dispatch), `behind_active_turn`, `paused` (own, ancestor or workspace Pause), `failed` (resumes on the next message), `requires_action`, `waiting_capacity` and `cancelled`, and `opengeni_turns_queued_oldest_age_seconds{hold}` gives the oldest queued age in each class. Only `ready` prompts wait for a worker, so an old `ready` prompt is a stranded queue. Migration 0988 adds the content-free `opengeni_private.summarize_queued_turns_by_hold()` function and `@opengeni/db` exports `summarizeQueuedTurnsByHold` and `QUEUED_TURN_HOLDS`. The runtime grant is deferred for one release, so these series appear only after a later migration grants it; until then the worker publishes only the total. Prompts from a non-owner on a personal-machine chat that wait for the machine owner are not yet a separate class and count as `ready`.
