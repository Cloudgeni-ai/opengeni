---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Releases can roll out over the production binary again. Migration 1283 withholds the runtime grant on the inventory of meeting tracks not yet kept compact, because the binary in production rejects that grant on a routine it does not know. Until a later release grants it again, existing meetings' audio stays as it is; new meetings are still kept compact.
