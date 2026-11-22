---
"@opengeni/db": patch
---

Settle a Modal sandbox create whose reply was lost once it is older than Modal's 24-hour maximum sandbox lifetime plus an hour. The lease then restarts cold from its archive, so the chat gets a fresh sandbox instead of waiting forever.
