---
"@opengeni/db": patch
---

Insights usage and calls responses are cached again. The cache fence had switched to the database-wide visibility snapshot, which changes whenever any transaction anywhere commits, so repeated reads always recomputed. The fence now fingerprints the workspace's committed session activity, so it changes only when a session in that workspace is created, written or deleted.
