---
"@opengeni/db": patch
"@opengeni/core": patch
---

Only a session created without an idempotency key is discarded when its start fails before the first turn. A keyed session stays, so a retry with the same key repairs it with the parameters it was first accepted with.
