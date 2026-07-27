---
"@opengeni/db": patch
---

Allow a cold sandbox lease to elect a new rematerialization attempt after a restore failure explicitly marked retryable, while continuing to block non-retryable degraded and unrecoverable archives.
