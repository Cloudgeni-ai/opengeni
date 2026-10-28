---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

A session parked in `wait_for_input` now resumes as soon as its background command's result is settled, instead of on the wake dispatcher's next 10-second sweep. Terminal background-command settlement returns the wake it commits. Its callers signal the session workflow after commit, concurrently and for at most 5 seconds: a Connected Machine's pushed completion, in-turn, API and reaper retained-process settlement, the selfhosted reaper, and lost or contained sandbox boxes. The dispatcher still delivers any wake a caller could not signal. Local Temporal (`docker compose` and the native dev stack) now serves each task queue from one partition, so queued turns start in the order they were queued. Start an existing local stack with no queued work, or reset its Temporal state, so no backlog is left in the removed partitions.
