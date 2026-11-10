---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

An archived session's purge now resumes at the table it left unfinished instead of calling every already-empty table again on each step, and still ends with one pass over every table that confirms nothing is left. It deletes the same rows with far fewer database calls.
