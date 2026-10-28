---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

A session parked in `wait_for_input` now resumes as soon as its background command's result is settled, instead of on the wake dispatcher's next 10-second sweep. Terminal background-command settlement returns the wake it commits, and every settlement caller (a Connected Machine's pushed completion, in-turn and reaper retained-process settlement, and the selfhosted reaper) signals the session workflow after commit; the dispatcher still delivers any wake a caller could not signal. Local Temporal (`docker compose` and the native dev stack) now serves each task queue from one partition, so queued turns start in the order they were queued.
