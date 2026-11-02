---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

When a session no person owns posts a notification and a workspace or organization webhook receives it, notify_user now tells the agent it was handed to that integration instead of reporting it undelivered.
