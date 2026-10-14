---
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

A context compaction cut short by its own attempt's cancellation (for example a turn worker draining during a deploy) is no longer reported as a summarization failure. The worker records `session.context.compaction.skipped` with `reason: "interrupted"`, keeps any explicit `/compact` request pending for the recovered attempt, and lets the cancellation recover the same turn as before. The timeline shows "Compaction interrupted" with retry copy instead of "Couldn't compact conversation history".
