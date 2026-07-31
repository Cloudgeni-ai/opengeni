---
"@opengeni/db": patch
"@opengeni/react": patch
---

Prevent a ready file restored during reconnect from being counted twice across the durable composer draft and the still-live attachment card. Canonical duplicate refs are removed before draft persistence and composer submission while custom mounts and exact draft revision/content conflict protection remain intact.
