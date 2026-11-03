---
"@opengeni/worker-bundle": patch
---

An approval decided at the very moment a turn paused for it now always resumes the turn. If the decision was saved while the session was still checking what to do next, its wake-up was missed and the turn could wait forever for a decision it already had. The wait now counts wake-ups from before that check, so a decision that lands mid-check triggers one more look. The same applies to a session waiting for provider capacity or retrying a recovering turn: a Pause, Steer or message that lands during that check now takes effect at once instead of at the end of the wait. Sessions already recorded before this change replay as they were; a session that is already stuck this way resumes on its next wake-up, such as a new message.
