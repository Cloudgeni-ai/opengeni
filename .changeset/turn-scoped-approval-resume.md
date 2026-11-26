---
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

An approval or question answer can no longer stop a session with "Open suffix resume event does not match an interruption".

- Only an answer recorded for the paused turn resumes it. Previously, a message sent while an earlier turn waited for approval could be resumed by that earlier turn's decision once it paused for its own approval.
- The scheduler and the resume claim now share one rule for this.
- A resume whose answer no longer matches an open call applies the pause's other decisions and keeps waiting for the rest, instead of failing the turn.
- A call that was still waiting for approval when its turn ended (for example because a new message replaced the pause) is now recorded as never run, instead of as an unknown outcome.
- The Connected Machine checkpoint note now shows only for sandbox failures.
