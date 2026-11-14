---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Task-note tools now explain a refused call instead of returning the raw database error. A save into a task tree that already holds its 500 active notes says so and points to task_note_archive; an unknown note, a reused operation ID, a note that is no longer active, a superseded attempt, invalid input and a brief database outage each get their own typed error code and next step. Any other first-party tool that fails with a raw database error now returns a short typed error with its SQLSTATE, and never the query, its parameters or the caller's own text.
