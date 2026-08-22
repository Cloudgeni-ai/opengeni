---
"@opengeni/config": minor
---

Add `OPENGENI_GOAL_IDLE_BACKOFF_MS` (comma-separated pacing delays before the n-th consecutive no-input goal continuation, default `3000,30000,120000,300000`) and `OPENGENI_GOAL_IDLE_BACKOFF_MAX_MS` (default `600000`), validated at boot. This is pacing, never a cap: any new input wakes the session immediately.
