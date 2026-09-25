---
"@opengeni/db": patch
"@opengeni/observability": patch
"@opengeni/runtime": patch
---

Make operational signals truthful: the session recovery backlog no longer counts effectively paused sessions as stale, a read-only first sandbox probe that finds no path is recorded as a completed startup phase, Knowledge index deferrals log a content-free cause, and repeated warnings can be throttled per key with a suppressed count.
