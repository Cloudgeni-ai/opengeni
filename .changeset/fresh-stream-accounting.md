---
"@opengeni/worker-bundle": patch
---

Keep proactive compaction token reports scoped to the current SDK stream after an in-activity retry. Ignore pre-stream reports and translate fresh report revisions without resetting usage identities or deduplication.