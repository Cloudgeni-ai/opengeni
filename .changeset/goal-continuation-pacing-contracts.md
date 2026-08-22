---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Add the `backoff_pending` goal continuation reason (idle pacing between consecutive no-input continuations, `nextAttemptAt` at the pacing deadline) and the `SessionGoalResumedReason` / `SessionGoalResumedEventPayload` contracts for `goal.resumed` (`api` for the operator PATCH, `external_input` for the system resume of a `max_auto_continuations` pause). The React goal pill treats `backoff_pending` as ordinary scheduled work.
