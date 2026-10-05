---
"@opengeni/db": patch
---

A worker shutdown during sandbox provisioning no longer makes the session's sandbox unrecoverable or fails the turn. The dying attempt now finishes its own provisioning cleanup before exiting and never terminates a box it already published, so the replacement attempt resumes that same box. If an unpublished box disappears anyway, the session is no longer marked as having lost its workspace.
