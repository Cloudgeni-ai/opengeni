---
"@opengeni/db": patch
---

Retry pending tool receipt registration only after PostgreSQL deadlock or serialization rollback, with fresh attempt fences and bounded backoff. Reject conflicting duplicate call content without replaying inference or tool effects.