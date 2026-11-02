---
"@opengeni/db": patch
"@opengeni/core": patch
---

Archived chats that still had something pending are now stopped and stored by the archive pass instead of waiting forever. Cancelling an archived chat no longer fails when one of its sub-chats is already stored, a sub-chat archived under a chat that is already stored now stops its own work, and undelivered updates, unanswered questions or input waits in an archived chat now count as work to cancel.
